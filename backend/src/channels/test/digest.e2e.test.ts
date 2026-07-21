/*
 * End-to-end coverage for daily Discord digests through the real channel
 * service, scheduler, durable queue, worker, and renderer. Only the external
 * connector and vault boundaries are faked so delivery payloads stay visible.
 */
import { describe, expect, it } from "vitest";

import type { Category, ChannelKind } from "@pigeon/shared";
import { withTestDb } from "../../../test/db";
import type { Db } from "../../db/index";
import { runMigrations } from "../../migrate/runner";
import { scheduleDailyDigests } from "../../queue/scheduler";
import { runWorkerTick } from "../../queue/worker-loop";
import type { Vault } from "../../vault/index";
import { renderDeliveryMessage } from "../renderer";
import type { RenderedDeliveryMessage } from "../renderer";
import { connectChannel, updateDeliverySettings } from "../service";
import type { ChannelConnector, DeliveryMessage } from "../types";

const WEBHOOK_URL =
  "https://discord.com/api/webhooks/123456789/digest-e2e-secret";
const CATEGORIES: Category[] = ["requires_action", "important", "noise"];

const fakeVault: Vault = {
  seal(plaintext) {
    return `sealed:${Buffer.from(plaintext, "utf8").toString("base64")}`;
  },
  open(ciphertext) {
    return Buffer.from(ciphertext.replace(/^sealed:/, ""), "base64").toString(
      "utf8",
    );
  },
};

interface FakeDiscordConnector extends ChannelConnector<{
  webhookUrl: string;
}> {
  testConfigs: Array<{ webhookUrl: string }>;
  messages: DeliveryMessage[];
  renderedMessages: RenderedDeliveryMessage[];
}

function createFakeDiscordConnector(): FakeDiscordConnector {
  const connector: FakeDiscordConnector = {
    kind: "discord",
    testConfigs: [],
    messages: [],
    renderedMessages: [],
    validateConfig(input: unknown) {
      if (
        typeof input !== "object" ||
        input === null ||
        typeof (input as { webhookUrl?: unknown }).webhookUrl !== "string"
      ) {
        throw new Error("invalid config");
      }
      return { webhookUrl: (input as { webhookUrl: string }).webhookUrl };
    },
    async sendTest(config) {
      connector.testConfigs.push(config);
      return { ok: true };
    },
    async send(_config, message) {
      connector.messages.push(message);
      connector.renderedMessages.push(renderDeliveryMessage(message));
      return {
        ok: true,
        providerMessageId: `discord-message-${connector.messages.length}`,
      };
    },
  };
  return connector;
}

function createFakeRegistry(connector: FakeDiscordConnector) {
  return {
    supportedKinds(): ChannelKind[] {
      return ["discord"];
    },
    get(kind: string): ChannelConnector {
      if (kind !== connector.kind) {
        throw new Error(`unsupported channel kind: ${kind}`);
      }
      return connector;
    },
  };
}

async function insertUser(db: Db): Promise<string> {
  const rows = await db.query`
    INSERT INTO users(email, name, password_hash)
    VALUES ('digest-e2e@example.com', 'Digest User', 'hash')
    RETURNING id
  `;
  return String(rows[0]?.id);
}

async function insertMailbox(db: Db, userId: string): Promise<string> {
  const rows = await db.query`
    INSERT INTO mailboxes(
      user_id, provider, protocol, label, address, host, port, tls,
      username, password_ciphertext
    ) VALUES (
      ${userId}, 'imap', 'imap', 'Digest inbox',
      'digest-mailbox@example.com', 'imap.example.com', 993, true,
      'digest-mailbox@example.com', ${fakeVault.seal("mail-password")}
    )
    RETURNING id
  `;
  return String(rows[0]?.id);
}

async function insertClassifiedEmail(
  db: Db,
  mailboxId: string,
  input: {
    providerUid: string;
    category: Category;
    summary: string;
    receivedAt: Date;
    classifiedAt: Date;
  },
): Promise<void> {
  await db.query`
    WITH inserted AS (
      INSERT INTO messages(
        user_id, identity_key, from_name, from_address, subject, body,
        received_at, summary, category, classified_at
      )
      SELECT
        user_id, ${input.providerUid}, 'Sender', 'sender@example.com',
        'Subject', 'Body', ${input.receivedAt}, ${input.summary},
        ${input.category}, ${input.classifiedAt}
      FROM mailboxes WHERE id = ${mailboxId}
      RETURNING id
    )
    INSERT INTO mailbox_messages(mailbox_id, message_id, provider_uid, seen)
    SELECT ${mailboxId}, id, ${input.providerUid}, false FROM inserted
  `;
}

describe("daily Discord digest e2e", () => {
  it("delivers a ranked capped window and closes overflow before the next digest", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const connector = createFakeDiscordConnector();
      const registry = createFakeRegistry(connector);
      const userId = await insertUser(db);
      const mailboxId = await insertMailbox(db, userId);
      const baselineAt = new Date("2026-01-12T00:00:00.000Z");
      const firstWindowEnd = new Date("2026-01-14T08:00:00.000Z");
      const secondWindowEnd = new Date("2026-01-15T08:00:00.000Z");

      await connectChannel(
        db,
        userId,
        "discord",
        { webhookUrl: WEBHOOK_URL },
        registry,
        fakeVault,
      );
      await updateDeliverySettings(db, userId, {
        mode: "daily",
        digestTime: "08:00",
        digestDays: [3, 4],
        timezone: "UTC",
      });
      await db.query`
        UPDATE delivery_settings
        SET
          delivery_baseline_at = ${baselineAt},
          last_digest_cutoff_at = NULL
        WHERE user_id = ${userId}
      `;

      const summaries: Record<Category, string[]> = {
        requires_action: [],
        important: [],
        noise: [],
      };
      for (const category of CATEGORIES) {
        for (let index = 0; index < 10; index += 1) {
          const summary = `${category}-${index}`;
          summaries[category].push(summary);
          await insertClassifiedEmail(db, mailboxId, {
            providerUid: summary,
            category,
            summary,
            // Classification recency deliberately opposes receipt recency so
            // "newest" is proven to mean the newest received email.
            receivedAt: new Date(
              firstWindowEnd.getTime() - 24 * 60 * 60_000 - index * 60_000,
            ),
            classifiedAt: new Date(
              firstWindowEnd.getTime() - 12 * 60 * 60_000 + index * 60_000,
            ),
          });
        }
      }
      const firstExpectedItems = CATEGORIES.flatMap((category) =>
        summaries[category]
          .slice(0, category === "noise" ? 5 : 10)
          .map((summary) => ({ category, summary })),
      );

      await scheduleDailyDigests(db, new Date("2026-01-14T08:05:00.000Z"));
      await runWorkerTick(
        db,
        fakeVault,
        5,
        undefined,
        undefined,
        undefined,
        registry,
      );

      const firstPayloads = [...connector.messages];
      const firstOverflowText = connector.renderedMessages.map(
        (message) => message.text,
      );
      const firstAttempts = await db.query`
        SELECT
          kind, scheduled_for, window_start, window_end, status, omitted_count
        FROM delivery_attempts
        WHERE user_id = ${userId}
        ORDER BY scheduled_for
      `;
      const firstSettings = await db.query`
        SELECT delivery_baseline_at, last_digest_cutoff_at
        FROM delivery_settings
        WHERE user_id = ${userId}
      `;

      await insertClassifiedEmail(db, mailboxId, {
        providerUid: "later-new-email",
        category: "important",
        summary: "later-new-email",
        receivedAt: new Date("2026-01-15T07:00:00.000Z"),
        classifiedAt: new Date("2026-01-15T07:05:00.000Z"),
      });
      await scheduleDailyDigests(db, new Date("2026-01-15T08:05:00.000Z"));
      await runWorkerTick(
        db,
        fakeVault,
        5,
        undefined,
        undefined,
        undefined,
        registry,
      );

      const laterAttempts = await db.query`
        SELECT
          kind, scheduled_for, window_start, window_end, status, omitted_count
        FROM delivery_attempts
        WHERE user_id = ${userId} AND scheduled_for = ${secondWindowEnd}
      `;
      const laterSettings = await db.query`
        SELECT delivery_baseline_at, last_digest_cutoff_at
        FROM delivery_settings
        WHERE user_id = ${userId}
      `;

      expect({
        connectionTests: connector.testConfigs,
        first: {
          payloads: firstPayloads,
          overflowText: firstOverflowText,
          attempts: firstAttempts,
          settings: firstSettings,
        },
        later: {
          payloads: connector.messages.slice(1),
          attempts: laterAttempts,
          settings: laterSettings,
        },
      }).toEqual({
        connectionTests: [{ webhookUrl: WEBHOOK_URL }],
        first: {
          payloads: [
            {
              type: "digest",
              username: "Digest User",
              items: firstExpectedItems,
              omittedCount: 5,
            },
          ],
          overflowText: [
            "This digest is capped to 25 emails, but there are 5 more available in Pigeon.",
          ],
          attempts: [
            {
              kind: "digest",
              scheduled_for: firstWindowEnd,
              window_start: baselineAt,
              window_end: firstWindowEnd,
              status: "sent",
              omitted_count: 5,
            },
          ],
          settings: [
            {
              delivery_baseline_at: baselineAt,
              last_digest_cutoff_at: firstWindowEnd,
            },
          ],
        },
        later: {
          payloads: [
            {
              type: "digest",
              username: "Digest User",
              items: [{ category: "important", summary: "later-new-email" }],
              omittedCount: 0,
            },
          ],
          attempts: [
            {
              kind: "digest",
              scheduled_for: secondWindowEnd,
              window_start: firstWindowEnd,
              window_end: secondWindowEnd,
              status: "sent",
              omitted_count: 0,
            },
          ],
          settings: [
            {
              delivery_baseline_at: baselineAt,
              last_digest_cutoff_at: secondWindowEnd,
            },
          ],
        },
      });
    } finally {
      await close();
    }
  });
});

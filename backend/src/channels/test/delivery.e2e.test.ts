/*
 * End-to-end coverage for quiet-triggered Discord digests through the real
 * channel service, scheduler, durable queue, and worker. Only the external
 * channel boundary is faked so sent payloads remain visible to the test.
 */
import { describe, expect, it } from "vitest";

import type { Category, ChannelKind } from "@pigeon/shared";
import { withTestDb } from "../../../test/db";
import type { Db } from "../../db/index";
import { runMigrations } from "../../migrate/runner";
import { scheduleQuietTriggeredDigests } from "../../queue/scheduler";
import { runWorkerTick } from "../../queue/worker-loop";
import { createVault } from "../../vault/index";
import type { Vault } from "../../vault/index";
import { connectChannel, updateDeliverySettings } from "../service";
import type { ChannelConnector, DeliveryMessage } from "../types";

const TEST_VAULT_KEY = "J371VUEASEUQsYjxvMKhAklLcZOslC7QAGV9/NWQTbY=";
const WEBHOOK_URL =
  "https://discord.com/api/webhooks/123456789/e2e-secret-token";

interface FakeDiscordConnector extends ChannelConnector<{
  webhookUrl: string;
}> {
  testConfigs: Array<{ webhookUrl: string }>;
  messages: DeliveryMessage[];
}

function createFakeDiscordConnector(): FakeDiscordConnector {
  const connector: FakeDiscordConnector = {
    kind: "discord",
    testConfigs: [],
    messages: [],
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
      return { ok: true, providerMessageId: "discord-message-1" };
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
    VALUES ('quiet-delivery-e2e@example.com', 'Quiet User', 'hash')
    RETURNING id
  `;
  return String(rows[0]?.id);
}

async function insertMailbox(
  db: Db,
  vault: Vault,
  userId: string,
): Promise<string> {
  const rows = await db.query`
    INSERT INTO mailboxes(
      user_id, provider, protocol, label, address, host, port, tls,
      username, password_ciphertext
    ) VALUES (
      ${userId}, 'imap', 'imap', 'Inbox',
      'quiet-delivery-mailbox@example.com', 'imap.example.com', 993, true,
      'quiet-delivery-mailbox@example.com', ${vault.seal("mail-password")}
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
): Promise<string> {
  const rows = await db.query`
    WITH inserted AS (
      INSERT INTO messages(
        user_id, identity_key, from_name, from_address, subject, body,
        received_at, summary, category, classified_at
      )
      SELECT
        user_id, ${input.providerUid}, 'Alice', 'alice@example.com',
        'Canonical message', 'Canonical body', ${input.receivedAt},
        ${input.summary}, ${input.category}, ${input.classifiedAt}
      FROM mailboxes WHERE id = ${mailboxId}
      RETURNING id
    ), linked AS (
      INSERT INTO mailbox_messages(mailbox_id, message_id, provider_uid, seen)
      SELECT ${mailboxId}, id, ${input.providerUid}, false FROM inserted
    )
    SELECT id FROM inserted
  `;
  return String(rows[0]?.id);
}

describe("quiet Discord delivery e2e", () => {
  it("sends one category-ranked digest when an action message closes the quiet window", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const vault = createVault(TEST_VAULT_KEY);
      const connector = createFakeDiscordConnector();
      const registry = createFakeRegistry(connector);
      const userId = await insertUser(db);
      const mailboxId = await insertMailbox(db, vault, userId);

      await connectChannel(
        db,
        userId,
        "discord",
        { webhookUrl: WEBHOOK_URL },
        registry,
        vault,
      );
      const settings = await updateDeliverySettings(db, userId, {
        mode: "quiet",
      });
      const baselineAt = settings.deliveryBaselineAt;
      const action = {
        category: "requires_action" as const,
        summary: "Reply before Friday.",
      };
      const important = {
        category: "important" as const,
        summary: "Review the account update.",
      };
      const noise = {
        category: "noise" as const,
        summary: "This week's newsletter.",
      };

      const actionMessageId = await insertClassifiedEmail(db, mailboxId, {
        providerUid: "quiet-action",
        ...action,
        receivedAt: new Date(baselineAt.getTime() + 1_000),
        classifiedAt: new Date(baselineAt.getTime() + 4_000),
      });
      await insertClassifiedEmail(db, mailboxId, {
        providerUid: "quiet-important",
        ...important,
        receivedAt: new Date(baselineAt.getTime() + 2_000),
        classifiedAt: new Date(baselineAt.getTime() + 3_000),
      });
      await insertClassifiedEmail(db, mailboxId, {
        providerUid: "quiet-noise",
        ...noise,
        receivedAt: new Date(baselineAt.getTime() + 3_000),
        classifiedAt: new Date(baselineAt.getTime() + 2_000),
      });
      const windowEnd = new Date(baselineAt.getTime() + 5_000);

      await scheduleQuietTriggeredDigests(db, windowEnd);
      await runWorkerTick(
        db,
        vault,
        5,
        undefined,
        undefined,
        undefined,
        registry,
      );

      const attempts = await db.query`
        SELECT kind, message_id, status, window_end, omitted_count
        FROM delivery_attempts
        WHERE user_id = ${userId}
      `;
      const digestItems = await db.query`
        SELECT di.category, di.summary
        FROM digest_items di
        JOIN delivery_attempts da ON da.id = di.delivery_attempt_id
        WHERE da.user_id = ${userId}
        ORDER BY di.position
      `;
      const deliverySettings = await db.query`
        SELECT last_digest_cutoff_at
        FROM delivery_settings
        WHERE user_id = ${userId}
      `;
      const immediateAttempts = await db.query`
        SELECT count(*)::int AS count
        FROM delivery_attempts
        WHERE user_id = ${userId} AND kind = 'immediate'
      `;

      expect({
        deliveryPayloads: connector.messages,
        attempts,
        digestItems,
        deliverySettings,
        immediatePayloads: connector.messages.filter(
          (message) => message.type === "immediate",
        ),
        immediateAttempts,
      }).toEqual({
        deliveryPayloads: [
          {
            type: "digest",
            username: "Quiet User",
            items: [action, important, noise],
            omittedCount: 0,
          },
        ],
        attempts: [
          {
            kind: "digest",
            message_id: actionMessageId,
            status: "sent",
            window_end: windowEnd,
            omitted_count: 0,
          },
        ],
        digestItems: [action, important, noise],
        deliverySettings: [{ last_digest_cutoff_at: windowEnd }],
        immediatePayloads: [],
        immediateAttempts: [{ count: 0 }],
      });
    } finally {
      await close();
    }
  });
});

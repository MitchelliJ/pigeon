/*
 * End-to-end coverage for quiet-mode Discord delivery through the real channel
 * services, immediate scheduler, durable queue, and worker. Only the external
 * channel boundary is faked so sent payloads remain visible to the test.
 */
import { describe, expect, it } from "vitest";

import type { ChannelKind } from "@pigeon/shared";
import { withTestDb } from "../../../test/db";
import type { Db } from "../../db/index";
import { runMigrations } from "../../migrate/runner";
import { scheduleImmediateDeliveries } from "../../queue/scheduler";
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
  classifiedAt: Date,
): Promise<void> {
  await db.query`
    INSERT INTO emails(
      mailbox_id, provider_uid, seen, from_name, from_address, subject, body,
      received_at, summary, category, classified_at
    ) VALUES (
      ${mailboxId}, 'quiet-delivery-e2e-uid', false, 'Alice',
      'alice@example.com', 'Action needed', 'Please reply.', ${classifiedAt},
      'Reply before Friday.', 'requires_action', ${classifiedAt}
    )
  `;
}

describe("quiet Discord delivery e2e", () => {
  it("sends one post-baseline requires-action email once through scheduler and worker ticks", async () => {
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
      const classifiedAt = new Date(
        settings.deliveryBaselineAt.getTime() + 1_000,
      );
      const schedulerNow = new Date(classifiedAt.getTime() + 1_000);
      await insertClassifiedEmail(db, mailboxId, classifiedAt);

      await scheduleImmediateDeliveries(db, schedulerNow);
      await runWorkerTick(
        db,
        vault,
        5,
        undefined,
        undefined,
        undefined,
        registry,
      );
      await scheduleImmediateDeliveries(db, schedulerNow);
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
        SELECT kind, status
        FROM delivery_attempts
        WHERE user_id = ${userId}
      `;
      expect({
        connectionTests: connector.testConfigs,
        deliveryPayloads: connector.messages,
        attempts,
      }).toEqual({
        connectionTests: [{ webhookUrl: WEBHOOK_URL }],
        deliveryPayloads: [
          {
            type: "immediate",
            category: "requires_action",
            summary: "Reply before Friday.",
          },
        ],
        attempts: [{ kind: "immediate", status: "sent" }],
      });
    } finally {
      await close();
    }
  });
});

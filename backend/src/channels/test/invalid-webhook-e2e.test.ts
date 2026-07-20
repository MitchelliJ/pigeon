/*
 * End-to-end coverage for a permanently invalid Discord webhook through the
 * real channel service, immediate scheduler, durable queue, worker, and
 * dashboard route. Only the external connector boundary is faked.
 */
import { describe, expect, it } from "vitest";

import type { ChannelKind } from "@pigeon/shared";
import { withTestDb } from "../../../test/db";
import { generateToken, hashToken } from "../../auth/tokens";
import type { Db } from "../../db/index";
import { dashboardRoutes } from "../../mailboxes/dashboard";
import { runMigrations } from "../../migrate/runner";
import { scheduleImmediateDeliveries } from "../../queue/scheduler";
import { runWorkerTick } from "../../queue/worker-loop";
import { createVault } from "../../vault/index";
import type { Vault } from "../../vault/index";
import { connectChannel, updateDeliverySettings } from "../service";
import type { ChannelConnector } from "../types";

const TEST_VAULT_KEY = "J371VUEASEUQsYjxvMKhAklLcZOslC7QAGV9/NWQTbY=";
const WEBHOOK_URL =
  "https://discord.com/api/webhooks/123456789/deleted-secret-token";
const SAFE_ERROR = "Discord responded with HTTP 404";

interface FakeDiscordConnector extends ChannelConnector<{
  webhookUrl: string;
}> {
  sendCount: number;
}

function createFakeDiscordConnector(): FakeDiscordConnector {
  const connector: FakeDiscordConnector = {
    kind: "discord",
    sendCount: 0,
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
    async sendTest() {
      return { ok: true };
    },
    async send() {
      connector.sendCount += 1;
      return { ok: false, retryable: false, reason: SAFE_ERROR };
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

async function insertUserAndSession(
  db: Db,
): Promise<{ userId: string; cookie: string }> {
  const users = await db.query`
    INSERT INTO users(email, name, password_hash)
    VALUES ('channel-failure-e2e@example.com', 'Channel Failure', 'hash')
    RETURNING id
  `;
  const userId = String(users[0]?.id);
  const token = generateToken();
  await db.query`
    INSERT INTO sessions(user_id, token_hash, expires_at)
    VALUES (${userId}, ${hashToken(token)}, now() + interval '1 day')
  `;
  return { userId, cookie: `pigeon_session=${token}` };
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
      'channel-failure-mailbox@example.com', 'imap.example.com', 993, true,
      'channel-failure-mailbox@example.com', ${vault.seal("mail-password")}
    )
    RETURNING id
  `;
  return String(rows[0]?.id);
}

async function insertClassifiedEmail(
  db: Db,
  mailboxId: string,
  providerUid: string,
  classifiedAt: Date,
): Promise<void> {
  await db.query`
    WITH inserted AS (
      INSERT INTO messages(
        user_id, identity_key, from_name, from_address, subject, body,
        received_at, summary, category, classified_at
      )
      SELECT
        user_id, ${providerUid}, 'Alice', 'alice@example.com', 'Action needed',
        'Please reply.', ${classifiedAt}, 'Reply before Friday.',
        'requires_action', ${classifiedAt}
      FROM mailboxes WHERE id = ${mailboxId}
      RETURNING id
    )
    INSERT INTO mailbox_messages(mailbox_id, message_id, provider_uid, seen)
    SELECT ${mailboxId}, id, ${providerUid}, false FROM inserted
  `;
}

describe("invalid Discord webhook e2e", () => {
  it("disables a 404 channel, exposes only its safe error, and stops scheduling new deliveries", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const vault = createVault(TEST_VAULT_KEY);
      const connector = createFakeDiscordConnector();
      const registry = createFakeRegistry(connector);
      const { userId, cookie } = await insertUserAndSession(db);
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
      const firstClassifiedAt = new Date(
        settings.deliveryBaselineAt.getTime() + 1_000,
      );
      await insertClassifiedEmail(
        db,
        mailboxId,
        "invalid-webhook-first",
        firstClassifiedAt,
      );

      await scheduleImmediateDeliveries(
        db,
        new Date(firstClassifiedAt.getTime() + 1_000),
      );
      await runWorkerTick(
        db,
        vault,
        5,
        undefined,
        undefined,
        undefined,
        registry,
      );

      const dashboardResponse = await dashboardRoutes(db).request(
        "/api/dashboard",
        { headers: { cookie } },
      );
      const dashboard = (await dashboardResponse.json()) as {
        channel: unknown;
      };
      const serializedDashboard = JSON.stringify(dashboard);

      const secondClassifiedAt = new Date(firstClassifiedAt.getTime() + 2_000);
      await insertClassifiedEmail(
        db,
        mailboxId,
        "invalid-webhook-second",
        secondClassifiedAt,
      );
      await scheduleImmediateDeliveries(
        db,
        new Date(secondClassifiedAt.getTime() + 1_000),
      );
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
        SELECT status, last_error
        FROM delivery_attempts
        WHERE user_id = ${userId}
        ORDER BY created_at
      `;
      const jobs = await db.query`
        SELECT status
        FROM jobs
        WHERE type = 'deliver_channel'
        ORDER BY created_at
      `;

      expect({
        dashboardStatus: dashboardResponse.status,
        channel: dashboard.channel,
        leakedWebhook: serializedDashboard.includes(WEBHOOK_URL),
        leakedConfig: serializedDashboard.includes('"config'),
        attempts,
        jobs,
        sendCount: connector.sendCount,
      }).toEqual({
        dashboardStatus: 200,
        channel: expect.objectContaining({
          kind: "discord",
          status: "error",
          lastError: SAFE_ERROR,
        }),
        leakedWebhook: false,
        leakedConfig: false,
        attempts: [{ status: "failed", last_error: SAFE_ERROR }],
        jobs: [{ status: "succeeded" }],
        sendCount: 1,
      });
    } finally {
      await close();
    }
  });
});

/*
 * Integration coverage for the provider-neutral delivery worker handler.
 * Delivery attempts are durable/idempotent, digest content comes only from
 * its snapshot, and connector outcomes decide retry versus permanent state.
 */
import { describe, expect, it } from "vitest";

import { withTestDb } from "../../../test/db";
import type { ChannelKind } from "@pigeon/shared";
import type { Db } from "../../db/index";
import { runMigrations } from "../../migrate/runner";
import { createVault } from "../../vault/index";
import type { Vault } from "../../vault/index";
import type {
  ChannelConnector,
  DeliveryMessage,
  SendResult,
} from "../../channels/types";
import { handleDeliverChannelJob } from "../handlers/deliver-channel";

const TEST_VAULT_KEY = "J371VUEASEUQsYjxvMKhAklLcZOslC7QAGV9/NWQTbY=";
const BASELINE = new Date("2026-01-01T00:00:00.000Z");
const WINDOW_START = new Date("2026-01-02T08:00:00.000Z");
const WINDOW_END = new Date("2026-01-03T08:00:00.000Z");

type Category = "requires_action" | "important" | "noise";

interface OwnerFixture {
  userId: string;
  mailboxId: string;
  channelId: string;
}

interface FakeConnector extends ChannelConnector<Record<string, unknown>> {
  results: SendResult[];
  messages: DeliveryMessage[];
}

function createFakeConnector(...results: SendResult[]): FakeConnector {
  const fake: FakeConnector = {
    kind: "discord",
    results,
    messages: [],
    validateConfig(input: unknown): Record<string, unknown> {
      return input as Record<string, unknown>;
    },
    async sendTest() {
      return { ok: true };
    },
    async send(_config, message) {
      fake.messages.push(message);
      return fake.results.shift() ?? { ok: true };
    },
  };
  return fake;
}

function createFakeRegistry(connector: FakeConnector) {
  return {
    supportedKinds(): ChannelKind[] {
      return ["discord"];
    },
    get(kind: string): ChannelConnector {
      if (kind !== connector.kind) throw new Error(`unsupported kind: ${kind}`);
      return connector;
    },
  };
}

async function insertOwner(
  db: Db,
  vault: Vault,
  suffix: string,
): Promise<OwnerFixture> {
  const userRows = await db.query`
    INSERT INTO users(email, name, password_hash)
    VALUES (${`${suffix}@example.com`}, 'Delivery User', 'hash')
    RETURNING id
  `;
  const userId = String(userRows[0]?.id);
  const address = `${suffix}-mailbox@example.com`;
  const mailboxRows = await db.query`
    INSERT INTO mailboxes(
      user_id, provider, protocol, label, address, host, port, tls,
      username, password_ciphertext
    ) VALUES (
      ${userId}, 'imap', 'imap', 'Inbox', ${address}, 'imap.example.com',
      993, true, ${address}, 'sealed-password'
    )
    RETURNING id
  `;
  const mailboxId = String(mailboxRows[0]?.id);
  const channelRows = await db.query`
    INSERT INTO channels(
      user_id, kind, config_encrypted, status, last_tested_at
    ) VALUES (
      ${userId}, 'discord',
      ${vault.seal(JSON.stringify({ webhookUrl: `https://discord.example/${suffix}` }))},
      'active', ${BASELINE}
    )
    RETURNING id
  `;
  const channelId = String(channelRows[0]?.id);
  await db.query`
    INSERT INTO delivery_settings(
      user_id, mode, delivery_baseline_at, last_digest_cutoff_at
    ) VALUES (${userId}, 'daily', ${BASELINE}, ${WINDOW_START})
  `;
  return { userId, mailboxId, channelId };
}

async function insertEmail(
  db: Db,
  mailboxId: string,
  suffix: string,
  category: Category,
  summary: string,
): Promise<string> {
  const providerUid = `uid-${suffix}`;
  const rows = await db.query`
    WITH inserted AS (
      INSERT INTO messages(
        user_id, identity_key, from_name, from_address, subject, body,
        received_at, summary, category, classified_at
      )
      SELECT
        user_id, ${providerUid}, 'Sender', 'sender@example.com', 'Subject',
        'Body', ${WINDOW_START}, ${summary}, ${category}, ${WINDOW_START}
      FROM mailboxes WHERE id = ${mailboxId}
      RETURNING id
    )
    INSERT INTO mailbox_messages(mailbox_id, message_id, provider_uid, seen)
    SELECT ${mailboxId}, id, ${providerUid}, false FROM inserted
    RETURNING message_id
  `;
  return String(rows[0]?.message_id);
}

async function insertImmediateAttempt(
  db: Db,
  vault: Vault,
  suffix: string,
  options: {
    status?: "pending" | "sent";
    category?: Category;
    summary?: string;
  } = {},
): Promise<{ attemptId: string; owner: OwnerFixture; emailId: string }> {
  const owner = await insertOwner(db, vault, suffix);
  const emailId = await insertEmail(
    db,
    owner.mailboxId,
    suffix,
    options.category ?? "requires_action",
    options.summary ?? "Reply to the customer.",
  );
  const rows = await db.query`
    INSERT INTO delivery_attempts(
      user_id, channel_id, kind, message_id, status, sent_at
    ) VALUES (
      ${owner.userId}, ${owner.channelId}, 'immediate', ${emailId},
      ${options.status ?? "pending"},
      ${options.status === "sent" ? WINDOW_END : null}
    )
    RETURNING id
  `;
  return { attemptId: String(rows[0]?.id), owner, emailId };
}

async function insertHeartbeatAttempt(
  db: Db,
  vault: Vault,
  suffix: string,
): Promise<{ attemptId: string; owner: OwnerFixture }> {
  const owner = await insertOwner(db, vault, suffix);
  await db.query`
    UPDATE delivery_settings
    SET mode = 'quiet'
    WHERE user_id = ${owner.userId}
  `;
  const rows = await db.query`
    INSERT INTO delivery_attempts(
      user_id, channel_id, kind, scheduled_for, window_start, window_end,
      status
    ) VALUES (
      ${owner.userId}, ${owner.channelId}, 'heartbeat', ${WINDOW_END},
      ${WINDOW_START}, ${WINDOW_END}, 'pending'
    )
    RETURNING id
  `;
  return { attemptId: String(rows[0]?.id), owner };
}

async function insertDigestAttempt(
  db: Db,
  vault: Vault,
  suffix: string,
): Promise<{
  attemptId: string;
  owner: OwnerFixture;
  emailId: string;
}> {
  const owner = await insertOwner(db, vault, suffix);
  const emailId = await insertEmail(
    db,
    owner.mailboxId,
    suffix,
    "noise",
    "Mutable email summary.",
  );
  const attemptRows = await db.query`
    INSERT INTO delivery_attempts(
      user_id, channel_id, kind, scheduled_for, window_start, window_end,
      status, omitted_count
    ) VALUES (
      ${owner.userId}, ${owner.channelId}, 'digest', ${WINDOW_END},
      ${WINDOW_START}, ${WINDOW_END}, 'pending', 2
    )
    RETURNING id
  `;
  const attemptId = String(attemptRows[0]?.id);
  await db.query`
    INSERT INTO digest_items(
      delivery_attempt_id, message_id, position, category, summary
    ) VALUES (
      ${attemptId}, ${emailId}, 1, 'important', 'Snapshotted digest summary.'
    )
  `;
  return { attemptId, owner, emailId };
}

describe("handleDeliverChannelJob", () => {
  it("no-ops an already-sent attempt without sending again", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const vault = createVault(TEST_VAULT_KEY);
      const { attemptId } = await insertImmediateAttempt(
        db,
        vault,
        "already-sent",
        { status: "sent" },
      );
      const connector = createFakeConnector();

      await handleDeliverChannelJob(
        db,
        vault,
        { deliveryAttemptId: attemptId },
        createFakeRegistry(connector),
      );

      expect(connector.messages).toEqual([]);
    } finally {
      await close();
    }
  });

  it("sends an immediate category and summary and marks the attempt sent", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const vault = createVault(TEST_VAULT_KEY);
      const { attemptId } = await insertImmediateAttempt(
        db,
        vault,
        "immediate-success",
        {
          category: "requires_action",
          summary: "Reply before Friday.",
        },
      );
      const connector = createFakeConnector({
        ok: true,
        providerMessageId: "discord-message-1",
      });

      await handleDeliverChannelJob(
        db,
        vault,
        { deliveryAttemptId: attemptId },
        createFakeRegistry(connector),
      );
      const rows = await db.query`
        SELECT status, provider_message_id, sent_at IS NOT NULL AS has_sent_at
        FROM delivery_attempts
        WHERE id = ${attemptId}
      `;

      expect({ messages: connector.messages, attempt: rows[0] }).toEqual({
        messages: [
          {
            type: "immediate",
            category: "requires_action",
            summary: "Reply before Friday.",
          },
        ],
        attempt: {
          status: "sent",
          provider_message_id: "discord-message-1",
          has_sent_at: true,
        },
      });
    } finally {
      await close();
    }
  });

  it("sends a heartbeat and marks it sent without advancing the digest cutoff", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const vault = createVault(TEST_VAULT_KEY);
      const { attemptId } = await insertHeartbeatAttempt(
        db,
        vault,
        "heartbeat-success",
      );
      const connector = createFakeConnector({ ok: true });

      await handleDeliverChannelJob(
        db,
        vault,
        { deliveryAttemptId: attemptId },
        createFakeRegistry(connector),
      );
      const rows = await db.query`
        SELECT da.status, ds.last_digest_cutoff_at
        FROM delivery_attempts da
        JOIN delivery_settings ds ON ds.user_id = da.user_id
        WHERE da.id = ${attemptId}
      `;

      expect({ messages: connector.messages, attempt: rows[0] }).toEqual({
        messages: [{ type: "heartbeat" }],
        attempt: {
          status: "sent",
          last_digest_cutoff_at: WINDOW_START,
        },
      });
    } finally {
      await close();
    }
  });

  it("fails a heartbeat superseded by an immediate send without calling the connector", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const vault = createVault(TEST_VAULT_KEY);
      const { attemptId, owner } = await insertHeartbeatAttempt(
        db,
        vault,
        "heartbeat-race",
      );
      const emailId = await insertEmail(
        db,
        owner.mailboxId,
        "heartbeat-race-immediate",
        "requires_action",
        "Send before the heartbeat worker starts.",
      );
      await db.query`
        INSERT INTO delivery_attempts(
          user_id, channel_id, kind, message_id, status, sent_at
        ) VALUES (
          ${owner.userId}, ${owner.channelId}, 'immediate', ${emailId}, 'sent',
          ${WINDOW_END}
        )
      `;
      const connector = createFakeConnector();

      await handleDeliverChannelJob(
        db,
        vault,
        { deliveryAttemptId: attemptId },
        createFakeRegistry(connector),
      );
      const rows = await db.query`
        SELECT status
        FROM delivery_attempts
        WHERE id = ${attemptId}
      `;

      expect({ messages: connector.messages, attempt: rows[0] }).toEqual({
        messages: [],
        attempt: { status: "failed" },
      });
    } finally {
      await close();
    }
  });

  it("sends quiet-triggered digest snapshot", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const vault = createVault(TEST_VAULT_KEY);
      const owner = await insertOwner(db, vault, "quiet-triggered-delivery");
      await db.query`
        UPDATE delivery_settings
        SET mode = 'quiet'
        WHERE user_id = ${owner.userId}
      `;
      const triggerMessageId = await insertEmail(
        db,
        owner.mailboxId,
        "quiet-triggered-delivery",
        "requires_action",
        "Mutable trigger summary.",
      );
      const attemptRows = await db.query`
        INSERT INTO delivery_attempts(
          user_id, channel_id, kind, message_id, scheduled_for, window_start,
          window_end, status, omitted_count
        ) VALUES (
          ${owner.userId}, ${owner.channelId}, 'digest', ${triggerMessageId},
          ${WINDOW_END}, ${WINDOW_START}, ${WINDOW_END}, 'pending', 1
        )
        RETURNING id
      `;
      const attemptId = String(attemptRows[0]?.id);
      await db.query`
        INSERT INTO digest_items(
          delivery_attempt_id, message_id, position, category, summary
        ) VALUES (
          ${attemptId}, ${triggerMessageId}, 1, 'requires_action',
          'Snapshotted quiet digest summary.'
        )
      `;
      const connector = createFakeConnector({ ok: true });

      await handleDeliverChannelJob(
        db,
        vault,
        { deliveryAttemptId: attemptId },
        createFakeRegistry(connector),
      );
      const rows = await db.query`
        SELECT da.status, ds.last_digest_cutoff_at
        FROM delivery_attempts da
        JOIN delivery_settings ds ON ds.user_id = da.user_id
        WHERE da.id = ${attemptId}
      `;

      expect({ messages: connector.messages, attempt: rows[0] }).toEqual({
        messages: [
          {
            type: "digest",
            username: "Delivery User",
            items: [
              {
                category: "requires_action",
                summary: "Snapshotted quiet digest summary.",
              },
            ],
            omittedCount: 1,
          },
        ],
        attempt: {
          status: "sent",
          last_digest_cutoff_at: WINDOW_END,
        },
      });
    } finally {
      await close();
    }
  });

  it("retries quiet-triggered digest from the same snapshot", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const vault = createVault(TEST_VAULT_KEY);
      const owner = await insertOwner(db, vault, "quiet-triggered-retry");
      await db.query`
        UPDATE delivery_settings
        SET mode = 'quiet'
        WHERE user_id = ${owner.userId}
      `;
      const triggerMessageId = await insertEmail(
        db,
        owner.mailboxId,
        "quiet-triggered-retry",
        "requires_action",
        "Mutable trigger summary.",
      );
      const attemptRows = await db.query`
        INSERT INTO delivery_attempts(
          user_id, channel_id, kind, message_id, scheduled_for, window_start,
          window_end, status, omitted_count
        ) VALUES (
          ${owner.userId}, ${owner.channelId}, 'digest', ${triggerMessageId},
          ${WINDOW_END}, ${WINDOW_START}, ${WINDOW_END}, 'pending', 1
        )
        RETURNING id
      `;
      const attemptId = String(attemptRows[0]?.id);
      await db.query`
        INSERT INTO digest_items(
          delivery_attempt_id, message_id, position, category, summary
        ) VALUES (
          ${attemptId}, ${triggerMessageId}, 1, 'important',
          'Original quiet digest snapshot.'
        )
      `;
      const connector = createFakeConnector(
        { ok: false, retryable: true, reason: "Discord request failed" },
        { ok: true },
      );
      const registry = createFakeRegistry(connector);

      await expect(
        handleDeliverChannelJob(
          db,
          vault,
          { deliveryAttemptId: attemptId },
          registry,
        ),
      ).rejects.toThrow("Discord request failed");
      const afterFailure = await db.query`
        SELECT last_digest_cutoff_at
        FROM delivery_settings
        WHERE user_id = ${owner.userId}
      `;

      await db.query`
        UPDATE messages
        SET summary = 'Changed before retry.', category = 'noise'
        WHERE id = ${triggerMessageId}
      `;
      await handleDeliverChannelJob(
        db,
        vault,
        { deliveryAttemptId: attemptId },
        registry,
      );
      const afterSuccess = await db.query`
        SELECT last_digest_cutoff_at
        FROM delivery_settings
        WHERE user_id = ${owner.userId}
      `;
      const snapshotMessage = {
        type: "digest",
        username: "Delivery User",
        items: [
          {
            category: "important",
            summary: "Original quiet digest snapshot.",
          },
        ],
        omittedCount: 1,
      };

      expect({
        messages: connector.messages,
        cutoffAfterFailure: afterFailure[0]?.last_digest_cutoff_at,
        cutoffAfterSuccess: afterSuccess[0]?.last_digest_cutoff_at,
      }).toEqual({
        messages: [snapshotMessage, snapshotMessage],
        cutoffAfterFailure: WINDOW_START,
        cutoffAfterSuccess: WINDOW_END,
      });
    } finally {
      await close();
    }
  });

  it("retries a digest from the same snapshot and advances its cutoff only after success", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const vault = createVault(TEST_VAULT_KEY);
      const { attemptId, owner, emailId } = await insertDigestAttempt(
        db,
        vault,
        "digest-retry",
      );
      await db.query`
        UPDATE messages
        SET summary = 'Changed after scheduling.', category = 'noise'
        WHERE id = ${emailId}
      `;
      const connector = createFakeConnector(
        { ok: false, retryable: true, reason: "Discord request failed" },
        { ok: true, providerMessageId: "digest-message-1" },
      );
      const registry = createFakeRegistry(connector);

      await expect(
        handleDeliverChannelJob(
          db,
          vault,
          { deliveryAttemptId: attemptId },
          registry,
        ),
      ).rejects.toThrow("Discord request failed");
      const afterRetry = await db.query`
        SELECT
          da.status,
          da.last_error,
          ds.delivery_baseline_at,
          ds.last_digest_cutoff_at
        FROM delivery_attempts da
        JOIN delivery_settings ds ON ds.user_id = da.user_id
        WHERE da.id = ${attemptId}
      `;

      await db.query`
        UPDATE messages
        SET summary = 'Changed again before retry.', category = 'requires_action'
        WHERE id = ${emailId}
      `;
      await handleDeliverChannelJob(
        db,
        vault,
        { deliveryAttemptId: attemptId },
        registry,
      );
      const afterSuccess = await db.query`
        SELECT
          da.status,
          da.provider_message_id,
          ds.delivery_baseline_at,
          ds.last_digest_cutoff_at
        FROM delivery_attempts da
        JOIN delivery_settings ds ON ds.user_id = da.user_id
        WHERE da.id = ${attemptId} AND da.user_id = ${owner.userId}
      `;
      const snapshotMessage = {
        type: "digest",
        username: "Delivery User",
        items: [
          {
            category: "important",
            summary: "Snapshotted digest summary.",
          },
        ],
        omittedCount: 2,
      };

      expect({
        messages: connector.messages,
        afterRetry,
        afterSuccess,
      }).toEqual({
        messages: [snapshotMessage, snapshotMessage],
        afterRetry: [
          {
            status: "pending",
            last_error: null,
            delivery_baseline_at: BASELINE,
            last_digest_cutoff_at: WINDOW_START,
          },
        ],
        afterSuccess: [
          {
            status: "sent",
            provider_message_id: "digest-message-1",
            delivery_baseline_at: BASELINE,
            last_digest_cutoff_at: WINDOW_END,
          },
        ],
      });
    } finally {
      await close();
    }
  });

  it("disables invalid webhooks but leaves the channel active for another permanent payload failure", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const vault = createVault(TEST_VAULT_KEY);
      const invalidWebhook = await insertImmediateAttempt(
        db,
        vault,
        "invalid-webhook",
      );
      const invalidPayload = await insertImmediateAttempt(
        db,
        vault,
        "invalid-payload",
      );

      await handleDeliverChannelJob(
        db,
        vault,
        { deliveryAttemptId: invalidWebhook.attemptId },
        createFakeRegistry(
          createFakeConnector({
            ok: false,
            retryable: false,
            reason: "Discord responded with HTTP 404",
          }),
        ),
      );
      await handleDeliverChannelJob(
        db,
        vault,
        { deliveryAttemptId: invalidPayload.attemptId },
        createFakeRegistry(
          createFakeConnector({
            ok: false,
            retryable: false,
            reason: "Discord responded with HTTP 400",
          }),
        ),
      );

      const rows = await db.query`
        SELECT da.id, da.status AS attempt_status, da.last_error,
               c.status AS channel_status
        FROM delivery_attempts da
        JOIN channels c ON c.id = da.channel_id
        WHERE da.id IN (${invalidWebhook.attemptId}, ${invalidPayload.attemptId})
        ORDER BY da.id
      `;
      const byId = Object.fromEntries(rows.map((row) => [String(row.id), row]));
      expect(byId).toMatchObject({
        [invalidWebhook.attemptId]: {
          attempt_status: "failed",
          channel_status: "error",
          last_error: "Discord responded with HTTP 404",
        },
        [invalidPayload.attemptId]: {
          attempt_status: "failed",
          channel_status: "active",
          last_error: "Discord responded with HTTP 400",
        },
      });
    } finally {
      await close();
    }
  });
});

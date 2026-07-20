/*
 * Integration tests for `runWorkerTick` (Job Queue, Workers & Scheduler PRD
 * §3.2 FR-11, §4). A tick claims up to `concurrency` jobs, dispatches each by
 * type, runs them concurrently, and completes or retries each queue job based
 * on whether its handler resolves or rejects.
 *
 * External mailbox, classifier, and channel boundaries use fakes; delivery
 * configuration still makes the real vault round trip before dispatch.
 */
import { describe, it, expect } from "vitest";
import { withTestDb } from "../../../test/db";
import { runMigrations } from "../../migrate/runner";
import { createVault } from "../../vault/index";
import {
  enqueueSyncJob,
  enqueueClassifyJob,
  enqueueDeliveryJob,
} from "../store";
import { runWorkerTick } from "../worker-loop";
import type { Db } from "../../db/index";
import type { Vault } from "../../vault/index";
import type {
  MailboxConnector,
  ListMessageIdsResult,
  FetchMessagesResult,
  TestConnectionParams,
} from "../../mailboxes/connectors/types";
import type {
  LlmClassifier,
  ClassifyInput,
  ClassifyResult,
} from "../../llm/index";
import type { ChannelConnector, DeliveryMessage } from "../../channels/types";

const TEST_VAULT_KEY = "J371VUEASEUQsYjxvMKhAklLcZOslC7QAGV9/NWQTbY=";

async function insertUser(db: Db, email: string): Promise<string> {
  const rows = await db.query`
    INSERT INTO users(email, name, password_hash)
    VALUES (${email}, ${"U"}, ${"h"})
    RETURNING id`;
  return String(rows[0]?.id);
}

async function insertMailbox(
  db: Db,
  vault: Vault,
  userId: string,
  address: string,
): Promise<string> {
  const rows = await db.query`
    INSERT INTO mailboxes(
      user_id, provider, protocol, label, address, host, port, tls,
      username, password_ciphertext
    ) VALUES (
      ${userId}, ${"imap"}, ${"imap"}, ${"Work"}, ${address},
      ${"imap.example.com"}, ${993}, ${true}, ${address},
      ${vault.seal("fake-password")}
    ) RETURNING id`;
  return String(rows[0]?.id);
}

/** Insert an unclassified canonical message and mailbox occurrence. */
async function insertEmail(db: Db, mailboxId: string): Promise<string> {
  const rows = await db.query`
    WITH inserted AS (
      INSERT INTO messages(
        user_id, identity_key, from_name, from_address, subject, body, received_at
      )
      SELECT
        user_id, 'uid-classify', 'Alice', 'alice@example.com', 'Hello',
        'Body text', ${new Date("2026-01-01T00:00:00Z")}
      FROM mailboxes WHERE id = ${mailboxId}
      RETURNING id
    )
    INSERT INTO mailbox_messages(mailbox_id, message_id, provider_uid, seen)
    SELECT ${mailboxId}, id, 'uid-classify', false FROM inserted
    RETURNING message_id`;
  return String(rows[0]?.message_id);
}

interface FakeClassifier extends LlmClassifier {
  result: ClassifyResult;
}

/** A fake LlmClassifier whose `result` the test sets before each run, mirroring
 *  `createFakeConnector`'s mutable-result-holder pattern. */
function createFakeClassifier(): FakeClassifier {
  const fake: FakeClassifier = {
    name: "fake",
    result: { ok: true, result: { summary: "s", category: "noise" } },
    async classify(_input: ClassifyInput) {
      return fake.result;
    },
  };
  return fake;
}

interface FakeConnector extends MailboxConnector {
  listMessageIdsResult: ListMessageIdsResult;
  fetchMessagesResult: FetchMessagesResult;
}

function createFakeConnector(): FakeConnector {
  const fake: FakeConnector = {
    listMessageIdsResult: { ok: true, ids: [] },
    fetchMessagesResult: { ok: true, messages: [] },
    async testConnection(_params: TestConnectionParams) {
      return { ok: true };
    },
    async listMessageIds(_params: TestConnectionParams, _opts) {
      return fake.listMessageIdsResult;
    },
    async fetchMessages(_params: TestConnectionParams, _ids, _opts) {
      return fake.fetchMessagesResult;
    },
  };
  return fake;
}

async function statusCounts(db: Db): Promise<Record<string, number>> {
  const rows = (await db.query`
    SELECT status, count(*)::int AS count FROM jobs GROUP BY status
  `) as unknown as Array<{ status: string; count: number }>;
  const counts: Record<string, number> = {};
  for (const row of rows) {
    counts[row.status] = row.count;
  }
  return counts;
}

describe("runWorkerTick", () => {
  it("claims, dispatches, and completes pending sync_mailbox jobs for multiple mailboxes in one tick", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const vault = createVault(TEST_VAULT_KEY);
      const userId = await insertUser(db, "wiring@example.com");
      const mailboxA = await insertMailbox(
        db,
        vault,
        userId,
        "wiring-a@example.com",
      );
      const mailboxB = await insertMailbox(
        db,
        vault,
        userId,
        "wiring-b@example.com",
      );
      await enqueueSyncJob(db, mailboxA);
      await enqueueSyncJob(db, mailboxB);

      const fake = createFakeConnector();
      fake.listMessageIdsResult = { ok: true, ids: ["wiring-msg"] };
      fake.fetchMessagesResult = {
        ok: true,
        messages: [
          {
            providerUid: "wiring-msg",
            fromName: "Alice",
            fromAddress: "alice@example.com",
            subject: "Hello",
            body: "Body",
            receivedAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
            seen: false,
          },
        ],
      };

      await runWorkerTick(db, vault, 5, () => fake);

      const jobRows = await db.query`SELECT status FROM jobs`;
      expect(jobRows.length).toBe(2);
      for (const row of jobRows) {
        expect(row.status).toBe("succeeded");
      }

      const emailsA = await db.query`
        SELECT message_id FROM mailbox_messages WHERE mailbox_id = ${mailboxA}`;
      const emailsB = await db.query`
        SELECT message_id FROM mailbox_messages WHERE mailbox_id = ${mailboxB}`;
      expect(emailsA.length).toBeGreaterThanOrEqual(1);
      expect(emailsB.length).toBeGreaterThanOrEqual(1);
    } finally {
      await close();
    }
  });

  it("claims at most `concurrency` jobs in one tick, leaving the rest pending", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const vault = createVault(TEST_VAULT_KEY);
      const userId = await insertUser(db, "concurrency@example.com");
      const mailboxA = await insertMailbox(
        db,
        vault,
        userId,
        "concurrency-a@example.com",
      );
      const mailboxB = await insertMailbox(
        db,
        vault,
        userId,
        "concurrency-b@example.com",
      );
      const mailboxC = await insertMailbox(
        db,
        vault,
        userId,
        "concurrency-c@example.com",
      );
      await enqueueSyncJob(db, mailboxA);
      await enqueueSyncJob(db, mailboxB);
      await enqueueSyncJob(db, mailboxC);

      const fake = createFakeConnector();
      fake.listMessageIdsResult = { ok: true, ids: [] };
      fake.fetchMessagesResult = { ok: true, messages: [] };

      await runWorkerTick(db, vault, 2, () => fake);

      const counts = await statusCounts(db);
      expect(counts.succeeded ?? 0).toBe(2);
      expect(counts.pending ?? 0).toBe(1);
    } finally {
      await close();
    }
  });

  it("fails a job (reschedules to pending with last_error set) when its handler rejects", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const vault = createVault(TEST_VAULT_KEY);
      const userId = await insertUser(db, "failure@example.com");
      const mailboxId = await insertMailbox(
        db,
        vault,
        userId,
        "failure-mb@example.com",
      );
      await enqueueSyncJob(db, mailboxId);

      const fake = createFakeConnector();
      fake.listMessageIdsResult = { ok: false, reason: "boom" };

      await runWorkerTick(db, vault, 5, () => fake);

      const rows = await db.query`
        SELECT status, last_error FROM jobs WHERE payload->>'mailboxId' = ${mailboxId}`;
      expect(rows.length).toBe(1);
      expect(rows[0]?.status).toBe("pending");
      expect(rows[0]?.last_error).toContain("boom");
    } finally {
      await close();
    }
  });

  it("claims, dispatches, and completes a pending summarize_classify job, writing summary/category onto the email", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const vault = createVault(TEST_VAULT_KEY);
      const userId = await insertUser(db, "classify-wiring@example.com");
      const mailboxId = await insertMailbox(
        db,
        vault,
        userId,
        "classify-wiring-mb@example.com",
      );
      const emailId = await insertEmail(db, mailboxId);
      await enqueueClassifyJob(db, emailId);

      const fake = createFakeConnector();
      const fakeClassifier = createFakeClassifier();
      fakeClassifier.result = {
        ok: true,
        result: { summary: "A short summary", category: "important" },
      };

      await runWorkerTick(db, vault, 5, () => fake, fakeClassifier);

      const jobRows = await db.query`
        SELECT status FROM jobs WHERE payload->>'messageId' = ${emailId}`;
      expect(jobRows.length).toBe(1);
      expect(jobRows[0]?.status).toBe("succeeded");

      const emailRows = await db.query`
        SELECT summary, category FROM messages WHERE id = ${emailId}`;
      expect(emailRows[0]?.summary).toBe("A short summary");
      expect(emailRows[0]?.category).toBe("important");
    } finally {
      await close();
    }
  });

  it("fails a summarize_classify job (reschedules to pending with last_error set) when the classifier resolves ok: false", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const vault = createVault(TEST_VAULT_KEY);
      const userId = await insertUser(db, "classify-failure@example.com");
      const mailboxId = await insertMailbox(
        db,
        vault,
        userId,
        "classify-failure-mb@example.com",
      );
      const emailId = await insertEmail(db, mailboxId);
      await enqueueClassifyJob(db, emailId);

      const fake = createFakeConnector();
      const fakeClassifier = createFakeClassifier();
      fakeClassifier.result = { ok: false, reason: "boom" };

      await runWorkerTick(db, vault, 5, () => fake, fakeClassifier);

      const rows = await db.query`
        SELECT status, last_error FROM jobs WHERE payload->>'messageId' = ${emailId}`;
      expect(rows.length).toBe(1);
      expect(rows[0]?.status).toBe("pending");
      expect(rows[0]?.last_error).toContain("boom");
    } finally {
      await close();
    }
  });

  it("dispatches deliver_channel and routes a retryable connector failure through queue backoff", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const vault = createVault(TEST_VAULT_KEY);
      const userId = await insertUser(db, "delivery-dispatch@example.com");
      const mailboxId = await insertMailbox(
        db,
        vault,
        userId,
        "delivery-dispatch-mb@example.com",
      );
      const emailId = await insertEmail(db, mailboxId);
      await db.query`
        UPDATE messages
        SET summary = 'Dispatch summary', category = 'requires_action',
            classified_at = now()
        WHERE id = ${emailId}
      `;
      const channelRows = await db.query`
        INSERT INTO channels(
          user_id, kind, config_encrypted, status, last_tested_at
        ) VALUES (
          ${userId}, 'discord',
          ${vault.seal(JSON.stringify({ webhookUrl: "https://discord.example/fake" }))},
          'active', now()
        )
        RETURNING id
      `;
      const channelId = String(channelRows[0]?.id);
      const attemptRows = await db.query`
        INSERT INTO delivery_attempts(
          user_id, channel_id, kind, message_id, status
        ) VALUES (${userId}, ${channelId}, 'immediate', ${emailId}, 'pending')
        RETURNING id
      `;
      const deliveryAttemptId = String(attemptRows[0]?.id);
      await enqueueDeliveryJob(db, deliveryAttemptId);

      const messages: DeliveryMessage[] = [];
      const channelConnector: ChannelConnector<Record<string, unknown>> = {
        kind: "discord",
        validateConfig: (input) => input as Record<string, unknown>,
        async sendTest() {
          return { ok: true };
        },
        async send(_config, message) {
          messages.push(message);
          return {
            ok: false,
            retryable: true,
            reason: "Discord request failed",
          };
        },
      };
      const channelRegistry = {
        supportedKinds: () => ["discord" as const],
        get: () => channelConnector,
      };

      await runWorkerTick(
        db,
        vault,
        5,
        () => createFakeConnector(),
        createFakeClassifier(),
        undefined,
        channelRegistry,
      );

      const jobs = await db.query`
        SELECT status, last_error
        FROM jobs
        WHERE payload->>'deliveryAttemptId' = ${deliveryAttemptId}
      `;
      const attempts = await db.query`
        SELECT status, last_error
        FROM delivery_attempts
        WHERE id = ${deliveryAttemptId}
      `;
      expect({ messages, jobs, attempts }).toEqual({
        messages: [
          {
            type: "immediate",
            category: "requires_action",
            summary: "Dispatch summary",
          },
        ],
        jobs: [
          {
            status: "pending",
            last_error: "Discord request failed",
          },
        ],
        attempts: [{ status: "pending", last_error: null }],
      });
    } finally {
      await close();
    }
  });
});

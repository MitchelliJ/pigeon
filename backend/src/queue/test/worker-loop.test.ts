/*
 * Integration tests for `runWorkerTick` (Job Queue, Workers & Scheduler PRD
 * §3.2 FR-11, §4). A tick claims up to `concurrency` jobs via `claimJobs`,
 * dispatches each by `type` (only `sync_mailbox` has a handler right now,
 * routed to `handleSyncMailboxJob`), runs them concurrently, and completes
 * (`completeJob`) or fails (`failJob`) each based on whether its handler call
 * resolved or rejected.
 *
 * Reuses the exact fake `MailboxConnector` + `insertUser`/`insertMailbox` +
 * `createVault(TEST_VAULT_KEY)` seeding pattern from
 * `../handlers/sync-mailbox.test.ts` / `../../sync/test/engine.test.ts`.
 *
 * RED note: at authoring time `../worker-loop` (`runWorkerTick`) does not
 * exist yet — this file is expected to fail at import/module-resolution
 * time, not just at an assertion.
 */
import { describe, it, expect } from "vitest";
import { withTestDb } from "../../../test/db";
import { runMigrations } from "../../migrate/runner";
import { createVault } from "../../vault/index";
import { enqueueSyncJob } from "../store";
import { runWorkerTick } from "../worker-loop";
import type { Db } from "../../db/index";
import type { Vault } from "../../vault/index";
import type {
  MailboxConnector,
  ListMessageIdsResult,
  FetchMessagesResult,
  TestConnectionParams,
} from "../../mailboxes/connectors/types";

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
            receivedAt: new Date("2026-07-01T00:00:00Z"),
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
        SELECT id FROM emails WHERE mailbox_id = ${mailboxA}`;
      const emailsB = await db.query`
        SELECT id FROM emails WHERE mailbox_id = ${mailboxB}`;
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
});

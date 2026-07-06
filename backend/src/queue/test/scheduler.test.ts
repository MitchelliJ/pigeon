/*
 * Integration tests for the scheduler tick (Job Queue, Workers & Scheduler
 * PRD §3.2 FR-7).
 *
 * Boots a real embedded Postgres via `withTestDb` + `runMigrations`, seeds a
 * user (with a given tier) + mailbox (with a given `last_synced_at`/`status`)
 * directly (same pattern as `../store.test.ts`), and exercises
 * `runSchedulerTick` against the genuine `mailboxes`/`jobs` tables.
 *
 * RED note: at authoring time `backend/src/queue/scheduler.ts` does not exist
 * — this file is expected to fail at import/module-resolution time, not just
 * at an assertion, until the scheduler module is implemented.
 */
import { describe, it, expect } from "vitest";
import { withTestDb } from "../../../test/db";
import { runMigrations } from "../../migrate/runner";
import { enqueueSyncJob, enqueueClassifyJob } from "../store";
import { runSchedulerTick, enqueueDueClassifyJobs } from "../scheduler";
import type { Db } from "../../db/index";

async function insertUser(
  db: Db,
  email: string,
  tier: string,
): Promise<string> {
  const rows = await db.query`
    INSERT INTO users(email, name, password_hash, tier)
    VALUES (${email}, ${"U"}, ${"h"}, ${tier})
    RETURNING id`;
  return String(rows[0]?.id);
}

async function insertMailbox(
  db: Db,
  userId: string,
  address: string,
  lastSyncedAt: Date | null,
  status?: string,
): Promise<string> {
  const rows = await db.query`
    INSERT INTO mailboxes(
      user_id, provider, protocol, label, address, host, port, tls,
      username, password_ciphertext, last_synced_at, status
    ) VALUES (
      ${userId}, ${"imap"}, ${"imap"}, ${"Work"}, ${address},
      ${"imap.example.com"}, ${993}, ${true}, ${address},
      ${"gcm:iv:tag:ct"}, ${lastSyncedAt}, ${status ?? "connected"}
    ) RETURNING id`;
  return String(rows[0]?.id);
}

async function insertEmail(
  db: Db,
  mailboxId: string,
  overrides?: { summary?: string; category?: string; classifiedAt?: Date },
): Promise<string> {
  const rows = await db.query`
    INSERT INTO emails(
      mailbox_id, provider_uid, seen, from_name, from_address,
      subject, body, received_at, summary, category, classified_at
    ) VALUES (
      ${mailboxId}, ${`uid-${Math.random().toString(36).slice(2)}`}, ${false},
      ${"Alice"}, ${"alice@example.com"}, ${"Hello"}, ${"Body text"},
      ${new Date("2026-01-01T00:00:00Z")},
      ${overrides?.summary ?? null}, ${overrides?.category ?? null},
      ${overrides?.classifiedAt ?? null}
    ) RETURNING id`;
  return String(rows[0]?.id);
}

describe("scheduler", () => {
  it("enqueues a mailbox that has never been synced (last_synced_at IS NULL), regardless of tier", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const userId = await insertUser(db, "sched-never@example.com", "free");
      const mailboxId = await insertMailbox(
        db,
        userId,
        "sched-never-mb@example.com",
        null,
      );

      await runSchedulerTick(db);

      const rows = await db.query`
        SELECT status, type FROM jobs WHERE payload->>'mailboxId' = ${mailboxId}`;
      expect(rows).toEqual([{ status: "pending", type: "sync_mailbox" }]);
    } finally {
      await close();
    }
  });

  it("enqueues a free-tier mailbox last synced 31 minutes ago (past the 30-minute free interval)", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const userId = await insertUser(db, "sched-free-due@example.com", "free");
      const rows0 = await db.query`SELECT now() - interval '31 minutes' AS ts`;
      const lastSyncedAt = new Date(rows0[0]?.ts as string);
      const mailboxId = await insertMailbox(
        db,
        userId,
        "sched-free-due-mb@example.com",
        lastSyncedAt,
      );

      await runSchedulerTick(db);

      const rows = await db.query`
        SELECT status FROM jobs WHERE payload->>'mailboxId' = ${mailboxId}`;
      expect(rows).toEqual([{ status: "pending" }]);
    } finally {
      await close();
    }
  });

  it("does not enqueue a free-tier mailbox last synced only 10 minutes ago", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const userId = await insertUser(
        db,
        "sched-free-notdue@example.com",
        "free",
      );
      const rows0 = await db.query`SELECT now() - interval '10 minutes' AS ts`;
      const lastSyncedAt = new Date(rows0[0]?.ts as string);
      const mailboxId = await insertMailbox(
        db,
        userId,
        "sched-free-notdue-mb@example.com",
        lastSyncedAt,
      );

      await runSchedulerTick(db);

      const rows = await db.query`
        SELECT id FROM jobs WHERE payload->>'mailboxId' = ${mailboxId}`;
      expect(rows.length).toBe(0);
    } finally {
      await close();
    }
  });

  it("still enqueues a due mailbox whose status is 'error' (AC-9: no special-casing errored mailboxes out of scheduling)", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const userId = await insertUser(db, "sched-error@example.com", "free");
      const rows0 = await db.query`SELECT now() - interval '1 hour' AS ts`;
      const lastSyncedAt = new Date(rows0[0]?.ts as string);
      const mailboxId = await insertMailbox(
        db,
        userId,
        "sched-error-mb@example.com",
        lastSyncedAt,
        "error",
      );

      await runSchedulerTick(db);

      const rows = await db.query`
        SELECT status FROM jobs WHERE payload->>'mailboxId' = ${mailboxId}`;
      expect(rows).toEqual([{ status: "pending" }]);
    } finally {
      await close();
    }
  });

  it("does not double-enqueue a due mailbox that already has a pending sync_mailbox job", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const userId = await insertUser(db, "sched-dupe@example.com", "free");
      const rows0 = await db.query`SELECT now() - interval '1 hour' AS ts`;
      const lastSyncedAt = new Date(rows0[0]?.ts as string);
      const mailboxId = await insertMailbox(
        db,
        userId,
        "sched-dupe-mb@example.com",
        lastSyncedAt,
      );
      await enqueueSyncJob(db, mailboxId);

      await runSchedulerTick(db);

      const rows = await db.query`
        SELECT id FROM jobs WHERE payload->>'mailboxId' = ${mailboxId}`;
      expect(rows.length).toBe(1);
    } finally {
      await close();
    }
  });

  it("enqueues a pending summarize_classify job for an email whose summary IS NULL", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const userId = await insertUser(db, "classify-due@example.com", "free");
      const mailboxId = await insertMailbox(
        db,
        userId,
        "classify-due-mb@example.com",
        null,
      );
      const emailId = await insertEmail(db, mailboxId);

      await enqueueDueClassifyJobs(db);

      const rows = await db.query`
        SELECT status, type FROM jobs WHERE payload->>'emailId' = ${emailId}`;
      expect(rows).toEqual([{ status: "pending", type: "summarize_classify" }]);
    } finally {
      await close();
    }
  });

  it("does not enqueue an already-classified email (summary set)", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const userId = await insertUser(db, "classify-done@example.com", "free");
      const mailboxId = await insertMailbox(
        db,
        userId,
        "classify-done-mb@example.com",
        null,
      );
      const emailId = await insertEmail(db, mailboxId, {
        summary: "Already summarized",
        category: "noise",
        classifiedAt: new Date("2026-01-02T00:00:00Z"),
      });

      await enqueueDueClassifyJobs(db);

      const rows = await db.query`
        SELECT id FROM jobs WHERE payload->>'emailId' = ${emailId}`;
      expect(rows.length).toBe(0);
    } finally {
      await close();
    }
  });

  it("does not double-enqueue an email that already has an in-flight summarize_classify job", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const userId = await insertUser(db, "classify-dupe@example.com", "free");
      const mailboxId = await insertMailbox(
        db,
        userId,
        "classify-dupe-mb@example.com",
        null,
      );
      const emailId = await insertEmail(db, mailboxId);
      await enqueueClassifyJob(db, emailId);

      await enqueueDueClassifyJobs(db);

      const rows = await db.query`
        SELECT id FROM jobs WHERE payload->>'emailId' = ${emailId}`;
      expect(rows.length).toBe(1);
    } finally {
      await close();
    }
  });
});

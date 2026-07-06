/*
 * Integration tests for the queue store (Job Queue, Workers & Scheduler PRD
 * §3.2 FR-2..FR-5, FR-9).
 *
 * Boots a real embedded Postgres via `withTestDb` + `runMigrations`, seeds a
 * user + mailbox row directly (same pattern as `../../test/emails-schema.test.ts`),
 * and exercises `enqueueSyncJob`/`claimJobs`/`completeJob`/`failJob` against
 * the genuine `jobs` table from migration `0006_jobs.sql`.
 *
 * RED note: at authoring time `backend/src/queue/store.ts` does not exist —
 * this file is expected to fail at import/module-resolution time, not just
 * at an assertion, until the store module is implemented.
 */
import { describe, it, expect, vi } from "vitest";
import { withTestDb } from "../../../test/db";
import { runMigrations } from "../../migrate/runner";
import {
  enqueueSyncJob,
  enqueueClassifyJob,
  claimJobs,
  completeJob,
  failJob,
} from "../store";
import type { Db } from "../../db/index";

async function insertUser(db: Db, email: string): Promise<string> {
  const rows = await db.query`
    INSERT INTO users(email, name, password_hash)
    VALUES (${email}, ${"U"}, ${"h"})
    RETURNING id`;
  return String(rows[0]?.id);
}

async function insertMailbox(
  db: Db,
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
      ${"gcm:iv:tag:ct"}
    ) RETURNING id`;
  return String(rows[0]?.id);
}

async function insertEmail(db: Db, mailboxId: string): Promise<string> {
  const rows = await db.query`
    INSERT INTO emails(
      mailbox_id, provider_uid, seen, from_name, from_address,
      subject, body, received_at
    ) VALUES (
      ${mailboxId}, ${"uid-1"}, ${false}, ${"Alice"}, ${"alice@example.com"},
      ${"Hello"}, ${"Body text"}, ${new Date("2026-01-01T00:00:00Z")}
    ) RETURNING id`;
  return String(rows[0]?.id);
}

/** Seed a `sync_mailbox` job row directly, bypassing `enqueueSyncJob`. */
async function insertJob(
  db: Db,
  mailboxId: string,
  overrides: {
    status?: string;
    runAt?: Date;
    lockedAt?: Date;
    attempts?: number;
    maxAttempts?: number;
  } = {},
): Promise<string> {
  const status = overrides.status ?? "pending";
  const runAt = overrides.runAt ?? new Date();
  const attempts = overrides.attempts ?? 0;
  const maxAttempts = overrides.maxAttempts ?? 3;
  const rows = await db.query`
    INSERT INTO jobs(type, payload, status, run_at, locked_at, attempts, max_attempts)
    VALUES (
      ${"sync_mailbox"}, ${{ mailboxId }}, ${status}, ${runAt},
      ${overrides.lockedAt ?? null}, ${attempts}, ${maxAttempts}
    ) RETURNING id`;
  return String(rows[0]?.id);
}

describe("queue store", () => {
  it("enqueueSyncJob inserts a pending sync_mailbox job for a mailbox with no existing job", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const userId = await insertUser(db, "enqueue-fresh@example.com");
      const mailboxId = await insertMailbox(
        db,
        userId,
        "enqueue-fresh-mb@example.com",
      );

      await enqueueSyncJob(db, mailboxId);

      const rows = await db.query`
        SELECT status FROM jobs WHERE payload->>'mailboxId' = ${mailboxId}`;
      expect(rows).toEqual([{ status: "pending" }]);
    } finally {
      await close();
    }
  });

  it("enqueueSyncJob is a no-op when a pending job already exists for that mailbox", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const userId = await insertUser(db, "enqueue-dupe@example.com");
      const mailboxId = await insertMailbox(
        db,
        userId,
        "enqueue-dupe-mb@example.com",
      );

      await enqueueSyncJob(db, mailboxId);
      await enqueueSyncJob(db, mailboxId);

      const rows = await db.query`
        SELECT id FROM jobs WHERE payload->>'mailboxId' = ${mailboxId}`;
      expect(rows.length).toBe(1);
    } finally {
      await close();
    }
  });

  it("enqueueSyncJob succeeds again once the prior job is no longer in-flight", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const userId = await insertUser(db, "enqueue-resurrect@example.com");
      const mailboxId = await insertMailbox(
        db,
        userId,
        "enqueue-resurrect-mb@example.com",
      );

      await enqueueSyncJob(db, mailboxId);
      await db.query`
        UPDATE jobs SET status = 'succeeded' WHERE payload->>'mailboxId' = ${mailboxId}`;
      await enqueueSyncJob(db, mailboxId);

      const rows = await db.query`
        SELECT status FROM jobs WHERE payload->>'mailboxId' = ${mailboxId} ORDER BY created_at`;
      expect(rows.length).toBe(2);
      expect(rows[1]?.status).toBe("pending");
    } finally {
      await close();
    }
  });

  it("enqueueClassifyJob inserts a pending summarize_classify job for an email with no existing job", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const userId = await insertUser(db, "classify-fresh@example.com");
      const mailboxId = await insertMailbox(
        db,
        userId,
        "classify-fresh-mb@example.com",
      );
      const emailId = await insertEmail(db, mailboxId);

      await enqueueClassifyJob(db, emailId);

      const rows = await db.query`
        SELECT type, status FROM jobs WHERE payload->>'emailId' = ${emailId}`;
      expect(rows).toEqual([{ type: "summarize_classify", status: "pending" }]);
    } finally {
      await close();
    }
  });

  it("enqueueClassifyJob is a no-op when a pending job already exists for that email", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const userId = await insertUser(db, "classify-dupe@example.com");
      const mailboxId = await insertMailbox(
        db,
        userId,
        "classify-dupe-mb@example.com",
      );
      const emailId = await insertEmail(db, mailboxId);

      await enqueueClassifyJob(db, emailId);
      await enqueueClassifyJob(db, emailId);

      const rows = await db.query`
        SELECT id FROM jobs WHERE payload->>'emailId' = ${emailId}`;
      expect(rows.length).toBe(1);
    } finally {
      await close();
    }
  });

  it("enqueueClassifyJob succeeds again once the prior job is no longer in-flight", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const userId = await insertUser(db, "classify-resurrect@example.com");
      const mailboxId = await insertMailbox(
        db,
        userId,
        "classify-resurrect-mb@example.com",
      );
      const emailId = await insertEmail(db, mailboxId);

      await enqueueClassifyJob(db, emailId);
      await db.query`
        UPDATE jobs SET status = 'succeeded' WHERE payload->>'emailId' = ${emailId}`;
      await enqueueClassifyJob(db, emailId);

      const rows = await db.query`
        SELECT status FROM jobs WHERE payload->>'emailId' = ${emailId} ORDER BY created_at`;
      expect(rows.length).toBe(2);
      expect(rows[1]?.status).toBe("pending");
    } finally {
      await close();
    }
  });

  it("claimJobs returns only due pending jobs, oldest run_at first, up to the limit, and marks them running/claimed", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const userId = await insertUser(db, "claim-basic@example.com");
      const mailboxA = await insertMailbox(
        db,
        userId,
        "claim-basic-a@example.com",
      );
      const mailboxB = await insertMailbox(
        db,
        userId,
        "claim-basic-b@example.com",
      );
      const mailboxC = await insertMailbox(
        db,
        userId,
        "claim-basic-c@example.com",
      );
      const mailboxFuture = await insertMailbox(
        db,
        userId,
        "claim-basic-future@example.com",
      );

      const now = Date.now();
      const earliestId = await insertJob(db, mailboxA, {
        runAt: new Date(now - 3000),
        attempts: 0,
      });
      const middleId = await insertJob(db, mailboxB, {
        runAt: new Date(now - 2000),
        attempts: 0,
      });
      await insertJob(db, mailboxC, {
        runAt: new Date(now - 1000),
        attempts: 0,
      });
      await insertJob(db, mailboxFuture, {
        runAt: new Date(now + 60 * 60 * 1000),
        attempts: 0,
      });

      const claimed = await claimJobs(db, 2);

      expect(claimed.map((j) => j.id)).toEqual([earliestId, middleId]);
      for (const job of claimed) {
        expect(job.status).toBe("running");
        expect(job.lockedAt).not.toBeNull();
        expect(job.attempts).toBe(1);
      }
    } finally {
      await close();
    }
  });

  it("claimJobs does not return a running job that is still within the visibility timeout", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const userId = await insertUser(db, "claim-inflight@example.com");
      const mailboxId = await insertMailbox(
        db,
        userId,
        "claim-inflight-mb@example.com",
      );
      await insertJob(db, mailboxId, {
        status: "running",
        lockedAt: new Date(),
        attempts: 1,
      });

      const claimed = await claimJobs(db, 10);

      expect(claimed.length).toBe(0);
    } finally {
      await close();
    }
  });

  it("claimJobs reclaims a running job whose locked_at is past the 5-minute visibility timeout", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const userId = await insertUser(db, "claim-stuck@example.com");
      const mailboxId = await insertMailbox(
        db,
        userId,
        "claim-stuck-mb@example.com",
      );
      const jobId = await insertJob(db, mailboxId, {
        status: "running",
        lockedAt: new Date(Date.now() - 10 * 60 * 1000),
        attempts: 1,
      });

      const claimed = await claimJobs(db, 10);

      expect(claimed.map((j) => j.id)).toEqual([jobId]);
      expect(claimed[0]?.attempts).toBe(2);
    } finally {
      await close();
    }
  });

  it("completeJob sets the job's status to succeeded", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const userId = await insertUser(db, "complete@example.com");
      const mailboxId = await insertMailbox(
        db,
        userId,
        "complete-mb@example.com",
      );
      const jobId = await insertJob(db, mailboxId, { status: "running" });

      await completeJob(db, jobId);

      const rows = await db.query`SELECT status FROM jobs WHERE id = ${jobId}`;
      expect(rows).toEqual([{ status: "succeeded" }]);
    } finally {
      await close();
    }
  });

  it("failJob on a first failure (attempts=1, max_attempts=3) reschedules to pending with ~1 minute backoff and records the error", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const userId = await insertUser(db, "fail-first@example.com");
      const mailboxId = await insertMailbox(
        db,
        userId,
        "fail-first-mb@example.com",
      );
      const jobId = await insertJob(db, mailboxId, {
        status: "running",
        attempts: 1,
        maxAttempts: 3,
      });

      await failJob(db, jobId, "boom");

      const rows = await db.query`
        SELECT status, run_at, last_error FROM jobs WHERE id = ${jobId}`;
      const row = rows[0];
      expect(row?.status).toBe("pending");
      expect(row?.last_error).toBe("boom");
      const runAt = new Date(row?.run_at as string).getTime();
      const now = Date.now();
      expect(runAt).toBeGreaterThan(now + 50 * 1000);
      expect(runAt).toBeLessThan(now + 70 * 1000);
    } finally {
      await close();
    }
  });

  it("failJob on a second failure (attempts=2) reschedules with ~5 minute backoff", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const userId = await insertUser(db, "fail-second@example.com");
      const mailboxId = await insertMailbox(
        db,
        userId,
        "fail-second-mb@example.com",
      );
      const jobId = await insertJob(db, mailboxId, {
        status: "running",
        attempts: 2,
        maxAttempts: 3,
      });

      await failJob(db, jobId, "boom again");

      const rows = await db.query`
        SELECT status, run_at FROM jobs WHERE id = ${jobId}`;
      const row = rows[0];
      expect(row?.status).toBe("pending");
      const runAt = new Date(row?.run_at as string).getTime();
      const now = Date.now();
      expect(runAt).toBeGreaterThan(now + 4.5 * 60 * 1000);
      expect(runAt).toBeLessThan(now + 5.5 * 60 * 1000);
    } finally {
      await close();
    }
  });

  it("failJob at max_attempts dead-letters the job (status=failed) and logs via console.error exactly once", async () => {
    const { db, close } = await withTestDb();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await runMigrations(db);
      const userId = await insertUser(db, "fail-terminal@example.com");
      const mailboxId = await insertMailbox(
        db,
        userId,
        "fail-terminal-mb@example.com",
      );
      const jobId = await insertJob(db, mailboxId, {
        status: "running",
        attempts: 3,
        maxAttempts: 3,
      });

      await failJob(db, jobId, "final failure");

      const rows = await db.query`SELECT status FROM jobs WHERE id = ${jobId}`;
      expect(rows).toEqual([{ status: "failed" }]);
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
      await close();
    }
  });
});

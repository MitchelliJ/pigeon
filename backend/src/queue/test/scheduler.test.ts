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
import {
  runSchedulerTick,
  enqueueDueClassifyJobs,
  scheduleImmediateDeliveries,
} from "../scheduler";
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
  overrides?: {
    summary?: string;
    category?: string;
    classifiedAt?: Date;
    receivedAt?: Date;
  },
): Promise<string> {
  const providerUid = `uid-${Math.random().toString(36).slice(2)}`;
  const rows = await db.query`
    WITH inserted AS (
      INSERT INTO messages(
        user_id, identity_key, from_name, from_address, subject, body,
        received_at, summary, category, classified_at
      )
      SELECT
        user_id, ${providerUid}, 'Alice', 'alice@example.com', 'Hello',
        'Body text',
        ${overrides?.receivedAt ?? new Date("2026-01-01T00:00:00Z")},
        ${overrides?.summary ?? null}, ${overrides?.category ?? null},
        ${overrides?.classifiedAt ?? null}
      FROM mailboxes WHERE id = ${mailboxId}
      RETURNING id
    )
    INSERT INTO mailbox_messages(mailbox_id, message_id, provider_uid, seen)
    SELECT ${mailboxId}, id, ${providerUid}, false FROM inserted
    RETURNING message_id`;
  return String(rows[0]?.message_id);
}

async function insertChannel(
  db: Db,
  userId: string,
  status: "active" | "error",
): Promise<string> {
  const rows = await db.query`
    INSERT INTO channels(user_id, kind, config_encrypted, status, last_tested_at)
    VALUES (${userId}, 'discord', 'sealed', ${status}, now())
    RETURNING id`;
  return String(rows[0]?.id);
}

async function insertDeliverySettings(
  db: Db,
  userId: string,
  mode: "daily" | "quiet",
  baselineAt: Date,
): Promise<void> {
  await db.query`
    INSERT INTO delivery_settings(user_id, mode, delivery_baseline_at)
    VALUES (${userId}, ${mode}, ${baselineAt})`;
}

async function insertDeliveryOwner(
  db: Db,
  suffix: string,
  mode: "daily" | "quiet",
  channelStatus: "active" | "error",
  baselineAt: Date,
): Promise<{
  userId: string;
  mailboxId: string;
  channelId: string;
}> {
  const userId = await insertUser(db, `${suffix}@example.com`, "free");
  const mailboxId = await insertMailbox(
    db,
    userId,
    `${suffix}-mb@example.com`,
    null,
  );
  const channelId = await insertChannel(db, userId, channelStatus);
  await insertDeliverySettings(db, userId, mode, baselineAt);
  return { userId, mailboxId, channelId };
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
        SELECT status, type FROM jobs WHERE payload->>'messageId' = ${emailId}`;
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
        SELECT id FROM jobs WHERE payload->>'messageId' = ${emailId}`;
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
        SELECT id FROM jobs WHERE payload->>'messageId' = ${emailId}`;
      expect(rows.length).toBe(1);
    } finally {
      await close();
    }
  });

  it("does not re-enqueue an email whose only summarize_classify job failed while still enqueueing an unclassified sibling", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const userId = await insertUser(
        db,
        "classify-failed@example.com",
        "free",
      );
      const mailboxId = await insertMailbox(
        db,
        userId,
        "classify-failed-mb@example.com",
        null,
      );
      const failedEmailId = await insertEmail(db, mailboxId);
      const siblingEmailId = await insertEmail(db, mailboxId);
      await db.query`
        INSERT INTO jobs (type, payload, status)
        VALUES (
          'summarize_classify',
          jsonb_build_object('messageId', ${failedEmailId}::text),
          'failed'
        )`;

      await enqueueDueClassifyJobs(db);

      const rows = await db.query`
        SELECT payload->>'messageId' AS message_id, status
        FROM jobs
        WHERE type = 'summarize_classify'
        ORDER BY message_id`;
      type ClassifyJobRow = { message_id: string; status: string };
      const orderedRows = [...(rows as ClassifyJobRow[])].sort(
        (left, right) =>
          left.status.localeCompare(right.status) ||
          left.message_id.localeCompare(right.message_id),
      );
      expect(orderedRows).toEqual([
        { message_id: failedEmailId, status: "failed" },
        { message_id: siblingEmailId, status: "pending" },
      ]);
    } finally {
      await close();
    }
  });

  it("enqueues at most 500 pending summarize_classify jobs per scheduler tick", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const userId = await insertUser(db, "classify-cap@example.com", "free");
      const mailboxId = await insertMailbox(
        db,
        userId,
        "classify-cap-mb@example.com",
        null,
      );
      for (let index = 0; index < 501; index += 1) {
        await insertEmail(db, mailboxId);
      }

      await enqueueDueClassifyJobs(db);

      const rows = await db.query`
        SELECT count(*)::int AS count FROM jobs WHERE type = 'summarize_classify'`;
      expect(rows).toEqual([{ count: 500 }]);
    } finally {
      await close();
    }
  });
});

describe("immediate delivery scheduler", () => {
  it("filters quiet delivery eligibility and idempotently creates owned attempts and jobs", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const baselineAt = new Date("2026-01-03T09:00:00Z");
      const classifiedAfter = new Date("2026-01-03T09:05:00Z");
      const receivedAfter = new Date("2026-01-03T09:01:00Z");
      const now = new Date("2026-01-03T10:00:00Z");

      const firstQuietOwner = await insertDeliveryOwner(
        db,
        "immediate-owner-a",
        "quiet",
        "active",
        baselineAt,
      );
      const firstEmailId = await insertEmail(db, firstQuietOwner.mailboxId, {
        summary: "First action.",
        category: "requires_action",
        classifiedAt: classifiedAfter,
        receivedAt: receivedAfter,
      });
      await insertEmail(db, firstQuietOwner.mailboxId, {
        summary: "Old classification.",
        category: "requires_action",
        classifiedAt: new Date("2026-01-03T08:59:00Z"),
        receivedAt: receivedAfter,
      });
      for (const category of ["important", "noise"]) {
        await insertEmail(db, firstQuietOwner.mailboxId, {
          summary: `${category} summary.`,
          category,
          classifiedAt: classifiedAfter,
          receivedAt: receivedAfter,
        });
      }

      const secondQuietOwner = await insertDeliveryOwner(
        db,
        "immediate-owner-b",
        "quiet",
        "active",
        baselineAt,
      );
      const secondEmailId = await insertEmail(db, secondQuietOwner.mailboxId, {
        summary: "Second action.",
        category: "requires_action",
        classifiedAt: classifiedAfter,
        receivedAt: receivedAfter,
      });

      const dailyOwner = await insertDeliveryOwner(
        db,
        "immediate-daily",
        "daily",
        "active",
        baselineAt,
      );
      await insertEmail(db, dailyOwner.mailboxId, {
        summary: "Daily action.",
        category: "requires_action",
        classifiedAt: classifiedAfter,
        receivedAt: receivedAfter,
      });

      const erroredOwner = await insertDeliveryOwner(
        db,
        "immediate-error",
        "quiet",
        "error",
        baselineAt,
      );
      await insertEmail(db, erroredOwner.mailboxId, {
        summary: "Errored channel action.",
        category: "requires_action",
        classifiedAt: classifiedAfter,
        receivedAt: receivedAfter,
      });

      await Promise.all([
        scheduleImmediateDeliveries(db, now),
        scheduleImmediateDeliveries(db, now),
        scheduleImmediateDeliveries(db, now),
      ]);
      await scheduleImmediateDeliveries(db, now);

      const attempts = await db.query`
        SELECT
          da.message_id,
          da.user_id AS attempt_user_id,
          da.channel_id,
          da.kind,
          da.status,
          m.user_id AS message_user_id,
          c.user_id AS channel_user_id
        FROM delivery_attempts da
        JOIN messages m ON m.id = da.message_id
        JOIN channels c ON c.id = da.channel_id
        WHERE da.kind = 'immediate'
        ORDER BY da.message_id`;
      const jobs = await db.query`
        SELECT da.message_id, j.type, j.status
        FROM jobs j
        LEFT JOIN delivery_attempts da
          ON da.id::text = j.payload->>'deliveryAttemptId'
        WHERE j.type = 'deliver_channel'
        ORDER BY da.message_id`;
      const eligible = [
        {
          emailId: firstEmailId,
          userId: firstQuietOwner.userId,
          channelId: firstQuietOwner.channelId,
        },
        {
          emailId: secondEmailId,
          userId: secondQuietOwner.userId,
          channelId: secondQuietOwner.channelId,
        },
      ];
      const expectedAttempts = eligible
        .map(({ emailId, userId, channelId }) => ({
          message_id: emailId,
          attempt_user_id: userId,
          channel_id: channelId,
          kind: "immediate",
          status: "pending",
          message_user_id: userId,
          channel_user_id: userId,
        }))
        .sort((left, right) => left.message_id.localeCompare(right.message_id));
      const expectedJobs = eligible
        .map(({ emailId }) => ({
          message_id: emailId,
          type: "deliver_channel",
          status: "pending",
        }))
        .sort((left, right) => left.message_id.localeCompare(right.message_id));

      expect({ attempts, jobs }).toEqual({
        attempts: expectedAttempts,
        jobs: expectedJobs,
      });
    } finally {
      await close();
    }
  });
});

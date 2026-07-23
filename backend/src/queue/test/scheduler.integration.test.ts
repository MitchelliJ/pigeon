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
  scheduleQuietTriggeredDigests,
  scheduleDailyDigests,
} from "../scheduler";
import type { Db } from "../../db/index";

async function insertUser(
  db: Db,
  email: string,
  tier: string,
  deletionRequestedAt?: Date | null,
): Promise<string> {
  const rows = await db.query`
    INSERT INTO users(email, name, password_hash, tier, deletion_requested_at)
    VALUES (${email}, ${"U"}, ${"h"}, ${tier}, ${deletionRequestedAt ?? null})
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

  it("does not enqueue sync work for a due mailbox owned by a pending-deletion user while still enqueueing the equivalent active-user mailbox", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const rows0 = await db.query`SELECT now() - interval '31 minutes' AS ts`;
      const lastSyncedAt = new Date(rows0[0]?.ts as string);
      const deletionRequestedAt = new Date("2026-01-15T12:00:00Z");
      const activeUserId = await insertUser(
        db,
        "sched-active@example.com",
        "free",
      );
      const pendingDeletionUserId = await insertUser(
        db,
        "sched-pending-deletion@example.com",
        "free",
        deletionRequestedAt,
      );
      const activeMailboxId = await insertMailbox(
        db,
        activeUserId,
        "sched-shared-mb-active@example.com",
        lastSyncedAt,
      );
      await insertMailbox(
        db,
        pendingDeletionUserId,
        "sched-shared-mb-pending-deletion@example.com",
        lastSyncedAt,
      );

      await runSchedulerTick(db);

      const rows = await db.query`
        SELECT
          j.type,
          j.status,
          j.payload->>'mailboxId' AS mailbox_id,
          m.user_id,
          u.deletion_requested_at
        FROM jobs j
        JOIN mailboxes m ON m.id::text = j.payload->>'mailboxId'
        JOIN users u ON u.id = m.user_id
        WHERE j.type = 'sync_mailbox'
        ORDER BY mailbox_id`;
      expect(rows).toEqual([
        {
          type: "sync_mailbox",
          status: "pending",
          mailbox_id: activeMailboxId,
          user_id: activeUserId,
          deletion_requested_at: null,
        },
      ]);
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

  it("excludes an otherwise eligible unclassified message for a pending-deletion user while still enqueueing the equivalent active-user message", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const deletionRequestedAt = new Date("2026-01-15T12:00:00Z");
      const activeUserId = await insertUser(
        db,
        "classify-active@example.com",
        "free",
      );
      const pendingDeletionUserId = await insertUser(
        db,
        "classify-pending-deletion@example.com",
        "free",
        deletionRequestedAt,
      );
      const activeMailboxId = await insertMailbox(
        db,
        activeUserId,
        "classify-active-mb@example.com",
        null,
      );
      const pendingDeletionMailboxId = await insertMailbox(
        db,
        pendingDeletionUserId,
        "classify-pending-deletion-mb@example.com",
        null,
      );
      const activeEmailId = await insertEmail(db, activeMailboxId);
      await insertEmail(db, pendingDeletionMailboxId);

      await enqueueDueClassifyJobs(db);

      const rows = await db.query`
        SELECT
          j.type,
          j.status,
          j.payload,
          m.user_id,
          u.deletion_requested_at,
          count(*) OVER ()::int AS total_count
        FROM jobs j
        JOIN messages m ON m.id::text = j.payload->>'messageId'
        JOIN users u ON u.id = m.user_id
        WHERE j.type = 'summarize_classify'
        ORDER BY m.id`;
      expect(rows).toEqual([
        {
          type: "summarize_classify",
          status: "pending",
          payload: { messageId: activeEmailId },
          user_id: activeUserId,
          deletion_requested_at: null,
          total_count: 1,
        },
      ]);
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

describe("quiet-triggered digest scheduler", () => {
  it("quiet-triggered digest snapshots all categories", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const baselineAt = new Date("2026-01-03T09:00:00Z");
      const now = new Date("2026-01-03T10:00:00Z");
      const owner = await insertDeliveryOwner(
        db,
        "quiet-triggered-all-categories",
        "quiet",
        "active",
        baselineAt,
      );
      const actionMessageId = await insertEmail(db, owner.mailboxId, {
        summary: "Action summary.",
        category: "requires_action",
        classifiedAt: new Date("2026-01-03T09:10:00Z"),
        receivedAt: new Date("2026-01-03T09:10:00Z"),
      });
      const importantMessageId = await insertEmail(db, owner.mailboxId, {
        summary: "Important summary.",
        category: "important",
        classifiedAt: new Date("2026-01-03T09:20:00Z"),
        receivedAt: new Date("2026-01-03T09:20:00Z"),
      });
      const noiseMessageId = await insertEmail(db, owner.mailboxId, {
        summary: "Noise summary.",
        category: "noise",
        classifiedAt: new Date("2026-01-03T09:30:00Z"),
        receivedAt: new Date("2026-01-03T09:30:00Z"),
      });

      await scheduleQuietTriggeredDigests(db, now);

      const attempts = await db.query`
        SELECT message_id, kind, status
        FROM delivery_attempts
        WHERE user_id = ${owner.userId}
      `;
      const items = await db.query`
        SELECT di.message_id, di.position, di.category, di.summary
        FROM digest_items di
        JOIN delivery_attempts da ON da.id = di.delivery_attempt_id
        WHERE da.user_id = ${owner.userId}
        ORDER BY di.position
      `;
      const jobs = await db.query`
        SELECT j.type, j.status
        FROM jobs j
        JOIN delivery_attempts da
          ON da.id::text = j.payload->>'deliveryAttemptId'
        WHERE da.user_id = ${owner.userId}
      `;
      const legacyImmediateAttempts = await db.query`
        SELECT count(*)::int AS count
        FROM delivery_attempts
        WHERE user_id = ${owner.userId} AND kind = 'immediate'
      `;

      expect({ attempts, items, jobs, legacyImmediateAttempts }).toEqual({
        attempts: [
          {
            message_id: actionMessageId,
            kind: "digest",
            status: "pending",
          },
        ],
        items: [
          {
            message_id: actionMessageId,
            position: 1,
            category: "requires_action",
            summary: "Action summary.",
          },
          {
            message_id: importantMessageId,
            position: 2,
            category: "important",
            summary: "Important summary.",
          },
          {
            message_id: noiseMessageId,
            position: 3,
            category: "noise",
            summary: "Noise summary.",
          },
        ],
        jobs: [{ type: "deliver_channel", status: "pending" }],
        legacyImmediateAttempts: [{ count: 0 }],
      });
    } finally {
      await close();
    }
  });

  it("does not trigger quiet digest without action", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const baselineAt = new Date("2026-01-03T09:00:00Z");
      const now = new Date("2026-01-03T10:00:00Z");
      const owner = await insertDeliveryOwner(
        db,
        "quiet-triggered-no-action",
        "quiet",
        "active",
        baselineAt,
      );
      await insertEmail(db, owner.mailboxId, {
        summary: "Important summary.",
        category: "important",
        classifiedAt: new Date("2026-01-03T09:10:00Z"),
        receivedAt: new Date("2026-01-03T09:10:00Z"),
      });
      await insertEmail(db, owner.mailboxId, {
        summary: "Noise summary.",
        category: "noise",
        classifiedAt: new Date("2026-01-03T09:20:00Z"),
        receivedAt: new Date("2026-01-03T09:20:00Z"),
      });

      await scheduleQuietTriggeredDigests(db, now);

      const rows = await db.query`
        SELECT
          (SELECT count(*)::int FROM delivery_attempts) AS attempt_count,
          (SELECT count(*)::int FROM digest_items) AS item_count,
          (SELECT count(*)::int FROM jobs WHERE type = 'deliver_channel')
            AS job_count
      `;
      expect(rows).toEqual([{ attempt_count: 0, item_count: 0, job_count: 0 }]);
    } finally {
      await close();
    }
  });

  it("quiet-triggered digest scheduler ignores daily mode while daily scheduler still creates that owner's due digest", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const baselineAt = new Date("2026-01-12T06:00:00Z");
      const dueAt = new Date("2026-01-12T08:00:00Z");
      const now = new Date("2026-01-12T10:00:00Z");
      const dailyOwner = await insertDeliveryOwner(
        db,
        "quiet-triggered-daily-mode",
        "daily",
        "active",
        baselineAt,
      );
      await db.query`
        UPDATE delivery_settings
        SET digest_time = '08:00'::time,
            digest_days = ARRAY[1]::smallint[],
            timezone = 'UTC'
        WHERE user_id = ${dailyOwner.userId}
      `;
      const actionMessageId = await insertEmail(db, dailyOwner.mailboxId, {
        summary: "Daily action summary.",
        category: "requires_action",
        classifiedAt: new Date("2026-01-12T07:30:00Z"),
        receivedAt: new Date("2026-01-12T07:30:00Z"),
      });

      await scheduleQuietTriggeredDigests(db, now);
      await scheduleDailyDigests(db, now);

      const attempts = await db.query`
        SELECT kind, message_id, scheduled_for, window_start, window_end, status
        FROM delivery_attempts
        WHERE user_id = ${dailyOwner.userId}
        ORDER BY scheduled_for NULLS LAST, message_id NULLS LAST
      `;
      const items = await db.query`
        SELECT di.message_id, di.position, di.category, di.summary
        FROM digest_items di
        JOIN delivery_attempts da ON da.id = di.delivery_attempt_id
        WHERE da.user_id = ${dailyOwner.userId}
        ORDER BY di.position
      `;
      const jobs = await db.query`
        SELECT j.type, j.status
        FROM jobs j
        JOIN delivery_attempts da
          ON da.id::text = j.payload->>'deliveryAttemptId'
        WHERE da.user_id = ${dailyOwner.userId}
      `;

      expect({ attempts, items, jobs }).toEqual({
        attempts: [
          {
            kind: "digest",
            message_id: null,
            scheduled_for: dueAt,
            window_start: baselineAt,
            window_end: dueAt,
            status: "pending",
          },
        ],
        items: [
          {
            message_id: actionMessageId,
            position: 1,
            category: "requires_action",
            summary: "Daily action summary.",
          },
        ],
        jobs: [{ type: "deliver_channel", status: "pending" }],
      });
    } finally {
      await close();
    }
  });

  it("does not create overlapping quiet-triggered digests", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const owner = await insertDeliveryOwner(
        db,
        "quiet-triggered-overlap",
        "quiet",
        "active",
        new Date("2026-01-03T09:00:00Z"),
      );
      await insertEmail(db, owner.mailboxId, {
        summary: "First action.",
        category: "requires_action",
        classifiedAt: new Date("2026-01-03T09:10:00Z"),
        receivedAt: new Date("2026-01-03T09:10:00Z"),
      });
      await insertEmail(db, owner.mailboxId, {
        summary: "Second action.",
        category: "requires_action",
        classifiedAt: new Date("2026-01-03T09:20:00Z"),
        receivedAt: new Date("2026-01-03T09:20:00Z"),
      });
      const firstTick = new Date("2026-01-03T09:15:00Z");
      const laterTick = new Date("2026-01-03T09:30:00Z");

      await scheduleQuietTriggeredDigests(db, firstTick);
      await scheduleQuietTriggeredDigests(db, firstTick);
      await Promise.all([
        scheduleQuietTriggeredDigests(db, laterTick),
        scheduleQuietTriggeredDigests(db, laterTick),
        scheduleQuietTriggeredDigests(db, laterTick),
      ]);
      await scheduleQuietTriggeredDigests(db, laterTick);

      const rows = await db.query`
        SELECT
          count(DISTINCT da.id)::int AS attempt_count,
          count(DISTINCT di.delivery_attempt_id)::int AS snapshot_count,
          count(di.message_id)::int AS item_count,
          count(DISTINCT di.message_id)::int AS distinct_item_count,
          count(DISTINCT j.id)::int AS job_count
        FROM delivery_attempts da
        LEFT JOIN digest_items di ON di.delivery_attempt_id = da.id
        LEFT JOIN jobs j
          ON j.type = 'deliver_channel'
         AND j.payload->>'deliveryAttemptId' = da.id::text
        WHERE da.channel_id = ${owner.channelId}
          AND da.kind = 'digest'
          AND da.message_id IS NOT NULL
          AND da.status = 'pending'
      `;
      expect(rows).toEqual([
        {
          attempt_count: 1,
          snapshot_count: 1,
          item_count: 1,
          distinct_item_count: 1,
          job_count: 1,
        },
      ]);
    } finally {
      await close();
    }
  });
});

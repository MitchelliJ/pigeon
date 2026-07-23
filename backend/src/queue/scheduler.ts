/*
 * Scheduler tick (Job Queue, Workers & Scheduler PRD §3.2 FR-7): decides
 * which mailboxes are due for a sync and enqueues a `sync_mailbox` job for
 * each one via `enqueueSyncJob`. "Due" depends on the owning user's tier
 * (`intervalForTier`, a plain JS lookup, not SQL) so the cutoff can't be
 * computed in a single WHERE clause — instead every mailbox is fetched with
 * its owner's tier and filtered in JS. `enqueueSyncJob` is itself idempotent
 * (no-op when a pending/running job already exists for that mailbox), so no
 * special-casing is needed here for double-enqueueing, and errored mailboxes
 * are scheduled the same as any other (AC-9: no status filtering).
 */
import type { Db } from "../db/index";
import { enqueueSyncJob, enqueueClassifyJob } from "./store";
import { intervalForTier } from "./tiers";

/** Raw snake_case row shape joining `mailboxes` to their owner's `tier`. */
interface DueCandidateRow {
  id: string;
  last_synced_at: string | Date | null;
  tier: string;
}

/** Whether a mailbox is due for a sync, given its tier's interval. */
function isDue(lastSyncedAt: string | Date | null, tier: string): boolean {
  if (lastSyncedAt === null) {
    return true;
  }
  const lastSyncedAtMs = new Date(lastSyncedAt).getTime();
  const intervalMs = intervalForTier(tier) * 60_000;
  return lastSyncedAtMs <= Date.now() - intervalMs;
}

/**
 * Run one scheduler tick: enqueue a sync job for every mailbox that's due,
 * per its owning user's tier interval.
 */
export async function runSchedulerTick(db: Db): Promise<void> {
  const rows = (await db.query`
    SELECT mailboxes.id, mailboxes.last_synced_at, users.tier
    FROM mailboxes
    JOIN users ON users.id = mailboxes.user_id
    WHERE users.deletion_requested_at IS NULL
  `) as unknown as DueCandidateRow[];

  const dueMailboxIds = rows
    .filter((row) => isDue(row.last_synced_at, row.tier))
    .map((row) => row.id);

  await Promise.all(
    dueMailboxIds.map((mailboxId) => enqueueSyncJob(db, mailboxId)),
  );
}

/**
 * Enqueue a `summarize_classify` job for every email still awaiting LLM
 * processing (LLM Processing PRD §3.2 FR-9). `summary IS NULL` does double
 * duty here: it's both the work-selection predicate and — because the handler
 * writes its results under a `WHERE summary IS NULL` guard — the idempotency
 * check, so an email that's already been summarized is never re-picked. The
 * 500-row cap bounds each tick's work, with any backlog picked up across
 * subsequent ticks. As with `runSchedulerTick`/`enqueueSyncJob`,
 * `enqueueClassifyJob`'s partial unique index absorbs already-in-flight jobs,
 * so no special-casing is needed here to avoid duplicates.
 *
 * An email whose classify job has already been dead-lettered (`status =
 * 'failed'` after exhausting its retries — a missing/expired MISTRAL_API_KEY
 * or a consistently un-parseable model reply) is deliberately excluded: its
 * `summary` stays NULL forever, so without this guard the tick would re-enqueue
 * it every minute, growing the `jobs` table unbounded and re-billing Mistral
 * for work that cannot succeed. Dead-lettering means "give up" — an operator
 * who fixes the underlying cause can delete the failed job row to re-arm it.
 */
export async function enqueueDueClassifyJobs(db: Db): Promise<void> {
  const rows = await db.query`
    SELECT m.id
    FROM messages m
    JOIN users u ON u.id = m.user_id
    WHERE m.summary IS NULL
      AND u.deletion_requested_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM jobs j
        WHERE j.type = 'summarize_classify'
          AND j.payload->>'messageId' = m.id::text
          AND j.status = 'failed'
      )
    ORDER BY m.received_at
    LIMIT 500
  `;
  await Promise.all(rows.map((row) => enqueueClassifyJob(db, String(row.id))));
}

/**
 * Queue account-erasure jobs for users whose 24-hour grace period has elapsed.
 * The insert is set-based and idempotent: the jobs table's uniqueness rules
 * absorb duplicate scheduler ticks via `ON CONFLICT DO NOTHING`.
 */
export async function enqueueDueAccountErasures(db: Db): Promise<void> {
  await db.query`
    INSERT INTO jobs(type, payload, status)
    SELECT
      'erase_account',
      jsonb_build_object('userId', users.id::text),
      'pending'
    FROM users
    WHERE deletion_requested_at IS NOT NULL
      AND deletion_requested_at + interval '24 hours' <= now()
    ON CONFLICT DO NOTHING
  `;
}

/**
 * Close a quiet-mode window when at least one new action email arrived, using
 * that action as the digest's idempotency key while snapshotting all eligible
 * categories exactly like a daily digest.
 */
export async function scheduleQuietTriggeredDigests(
  db: Db,
  now: Date,
): Promise<void> {
  await db.withTx(async (tx) => {
    await tx`
      WITH candidates AS (
        SELECT
          ds.user_id,
          c.id AS channel_id,
          ds.delivery_baseline_at,
          COALESCE(
            ds.last_digest_cutoff_at,
            ds.delivery_baseline_at
          ) AS window_start,
          trigger_message.id AS message_id
        FROM delivery_settings ds
        JOIN users u ON u.id = ds.user_id
        JOIN channels c
          ON c.user_id = ds.user_id
         AND c.status = 'active'
        JOIN LATERAL (
          SELECT m.id
          FROM messages m
          WHERE m.user_id = ds.user_id
            AND m.summary IS NOT NULL
            AND m.category = 'requires_action'
            AND m.classified_at > COALESCE(
              ds.last_digest_cutoff_at,
              ds.delivery_baseline_at
            )
            AND m.classified_at <= ${now}
            AND m.received_at >= ds.delivery_baseline_at
          ORDER BY m.received_at DESC, m.classified_at DESC, m.id DESC
          LIMIT 1
        ) trigger_message ON true
        WHERE ds.mode = 'quiet'
          AND u.deletion_requested_at IS NULL
          AND NOT EXISTS (
            SELECT 1
            FROM delivery_attempts pending_digest
            WHERE pending_digest.channel_id = c.id
              AND pending_digest.kind = 'digest'
              AND pending_digest.message_id IS NOT NULL
              AND pending_digest.status = 'pending'
          )
      ),
      ranked AS (
        SELECT
          c.channel_id,
          c.message_id,
          m.id AS item_message_id,
          m.category,
          m.summary,
          row_number() OVER (
            PARTITION BY c.channel_id, c.message_id
            ORDER BY
              CASE m.category
                WHEN 'requires_action' THEN 1
                WHEN 'important' THEN 2
                WHEN 'noise' THEN 3
              END,
              m.received_at DESC,
              m.classified_at DESC,
              m.id DESC
          ) AS position,
          count(*) OVER (
            PARTITION BY c.channel_id, c.message_id
          ) AS total_count
        FROM candidates c
        JOIN messages m ON m.user_id = c.user_id
        WHERE m.summary IS NOT NULL
          AND m.category IS NOT NULL
          AND m.classified_at > c.window_start
          AND m.classified_at <= ${now}
          AND m.received_at >= c.delivery_baseline_at
      ),
      inserted_attempts AS (
        INSERT INTO delivery_attempts(
          user_id,
          channel_id,
          kind,
          message_id,
          scheduled_for,
          window_start,
          window_end,
          status,
          omitted_count
        )
        SELECT
          c.user_id,
          c.channel_id,
          'digest',
          c.message_id,
          ${now},
          c.window_start,
          ${now},
          'pending',
          GREATEST(
            COALESCE((
              SELECT max(r.total_count)
              FROM ranked r
              WHERE r.channel_id = c.channel_id
                AND r.message_id = c.message_id
            ), 0) - 25,
            0
          )::integer
        FROM candidates c
        ON CONFLICT DO NOTHING
        RETURNING id, channel_id, message_id
      ),
      inserted_items AS (
        INSERT INTO digest_items(
          delivery_attempt_id,
          message_id,
          position,
          category,
          summary
        )
        SELECT
          ia.id,
          r.item_message_id,
          r.position::smallint,
          r.category,
          r.summary
        FROM inserted_attempts ia
        JOIN ranked r
          ON r.channel_id = ia.channel_id
         AND r.message_id = ia.message_id
        WHERE r.position <= 25
        RETURNING delivery_attempt_id
      )
      INSERT INTO jobs(type, payload, status)
      SELECT
        'deliver_channel',
        jsonb_build_object('deliveryAttemptId', ia.id::text),
        'pending'
      FROM inserted_attempts ia
      ON CONFLICT DO NOTHING
    `;
  });
}

/**
 * Queue the latest due Monday 08:00 local heartbeat for active quiet-mode
 * channels when no successful user-facing quiet activity occurred in its
 * preceding weekly window.
 */
export async function scheduleQuietHeartbeats(
  db: Db,
  now: Date,
): Promise<void> {
  await db.withTx(async (tx) => {
    await tx`
      WITH candidates AS (
        SELECT
          ds.user_id,
          c.id AS channel_id,
          due.scheduled_for,
          GREATEST(
            previous_slot.scheduled_for,
            ds.delivery_baseline_at
          ) AS window_start
        FROM delivery_settings ds
        JOIN users u ON u.id = ds.user_id
        JOIN channels c
          ON c.user_id = ds.user_id
         AND c.status = 'active'
        CROSS JOIN LATERAL (
          SELECT
            (days.local_day::date + TIME '08:00') AT TIME ZONE ds.timezone
              AS scheduled_for
          FROM generate_series(
            date_trunc('day', ${now}::timestamptz AT TIME ZONE ds.timezone)
              - INTERVAL '7 days',
            date_trunc('day', ${now}::timestamptz AT TIME ZONE ds.timezone),
            INTERVAL '1 day'
          ) AS days(local_day)
          WHERE EXTRACT(ISODOW FROM days.local_day)::smallint = 1
            AND (days.local_day::date + TIME '08:00')
                  AT TIME ZONE ds.timezone <= ${now}
          ORDER BY scheduled_for DESC
          LIMIT 1
        ) due
        CROSS JOIN LATERAL (
          SELECT
            (
              (due.scheduled_for AT TIME ZONE ds.timezone)::date - 7
                + TIME '08:00'
            ) AT TIME ZONE ds.timezone AS scheduled_for
        ) previous_slot
        WHERE ds.mode = 'quiet'
          AND u.deletion_requested_at IS NULL
          AND due.scheduled_for > ds.delivery_baseline_at
      ),
      inserted_attempts AS (
        INSERT INTO delivery_attempts(
          user_id,
          channel_id,
          kind,
          scheduled_for,
          window_start,
          window_end,
          status
        )
        SELECT
          candidate.user_id,
          candidate.channel_id,
          'heartbeat',
          candidate.scheduled_for,
          candidate.window_start,
          candidate.scheduled_for,
          'pending'
        FROM candidates candidate
        WHERE NOT EXISTS (
          SELECT 1
          FROM delivery_attempts recent_user_facing_activity
          WHERE recent_user_facing_activity.channel_id = candidate.channel_id
            AND (
              recent_user_facing_activity.kind = 'immediate'
              OR (
                recent_user_facing_activity.kind = 'digest'
                AND recent_user_facing_activity.message_id IS NOT NULL
              )
            )
            AND recent_user_facing_activity.status = 'sent'
            AND recent_user_facing_activity.sent_at > candidate.window_start
            AND recent_user_facing_activity.sent_at <= ${now}
        )
        ON CONFLICT DO NOTHING
        RETURNING id
      )
      INSERT INTO jobs(type, payload, status)
      SELECT
        'deliver_channel',
        jsonb_build_object('deliveryAttemptId', id::text),
        'pending'
      FROM inserted_attempts
      ON CONFLICT DO NOTHING
    `;
  });
}

/**
 * Close the latest due user-local digest window into an immutable snapshot.
 * The attempt's unique index elects one concurrent scheduler; only that winner
 * writes items and a delivery job. Successful delivery advances the cutoff.
 */
export async function scheduleDailyDigests(db: Db, now: Date): Promise<void> {
  await db.withTx(async (tx) => {
    await tx`
      WITH candidates AS (
        SELECT
          ds.user_id,
          c.id AS channel_id,
          ds.delivery_baseline_at,
          COALESCE(
            ds.last_digest_cutoff_at,
            ds.delivery_baseline_at
          ) AS window_start,
          due.scheduled_for
        FROM delivery_settings ds
        JOIN users u ON u.id = ds.user_id
        JOIN channels c
          ON c.user_id = ds.user_id
         AND c.status = 'active'
        CROSS JOIN LATERAL (
          SELECT
            (days.local_day::date + ds.digest_time) AT TIME ZONE ds.timezone
              AS scheduled_for
          FROM generate_series(
            date_trunc('day', ${now}::timestamptz AT TIME ZONE ds.timezone)
              - INTERVAL '7 days',
            date_trunc('day', ${now}::timestamptz AT TIME ZONE ds.timezone),
            INTERVAL '1 day'
          ) AS days(local_day)
          WHERE EXTRACT(ISODOW FROM days.local_day)::smallint
                  = ANY(ds.digest_days)
            AND (days.local_day::date + ds.digest_time)
                  AT TIME ZONE ds.timezone <= ${now}
          ORDER BY scheduled_for DESC
          LIMIT 1
        ) due
        WHERE ds.mode = 'daily'
          AND u.deletion_requested_at IS NULL
          AND due.scheduled_for > COALESCE(
            ds.last_digest_cutoff_at,
            ds.delivery_baseline_at
          )
      ),
      ranked AS (
        SELECT
          c.channel_id,
          c.scheduled_for,
          m.id AS message_id,
          m.category,
          m.summary,
          row_number() OVER (
            PARTITION BY c.channel_id, c.scheduled_for
            ORDER BY
              CASE m.category
                WHEN 'requires_action' THEN 1
                WHEN 'important' THEN 2
                WHEN 'noise' THEN 3
              END,
              m.received_at DESC,
              m.classified_at DESC,
              m.id DESC
          ) AS position,
          count(*) OVER (
            PARTITION BY c.channel_id, c.scheduled_for
          ) AS total_count
        FROM candidates c
        JOIN messages m ON m.user_id = c.user_id
        WHERE m.summary IS NOT NULL
          AND m.category IS NOT NULL
          AND m.classified_at > c.window_start
          AND m.classified_at <= c.scheduled_for
          AND m.received_at >= c.delivery_baseline_at
      ),
      inserted_attempts AS (
        INSERT INTO delivery_attempts(
          user_id,
          channel_id,
          kind,
          scheduled_for,
          window_start,
          window_end,
          status,
          omitted_count
        )
        SELECT
          c.user_id,
          c.channel_id,
          'digest',
          c.scheduled_for,
          c.window_start,
          c.scheduled_for,
          'pending',
          GREATEST(
            COALESCE((
              SELECT max(r.total_count)
              FROM ranked r
              WHERE r.channel_id = c.channel_id
                AND r.scheduled_for = c.scheduled_for
            ), 0) - 25,
            0
          )::integer
        FROM candidates c
        ON CONFLICT DO NOTHING
        RETURNING id, channel_id, scheduled_for
      ),
      inserted_items AS (
        INSERT INTO digest_items(
          delivery_attempt_id,
          message_id,
          position,
          category,
          summary
        )
        SELECT
          ia.id,
          r.message_id,
          r.position::smallint,
          r.category,
          r.summary
        FROM inserted_attempts ia
        JOIN ranked r
          ON r.channel_id = ia.channel_id
         AND r.scheduled_for = ia.scheduled_for
        WHERE r.position <= 25
        RETURNING delivery_attempt_id
      )
      INSERT INTO jobs(type, payload, status)
      SELECT
        'deliver_channel',
        jsonb_build_object('deliveryAttemptId', ia.id::text),
        'pending'
      FROM inserted_attempts ia
      ON CONFLICT DO NOTHING
    `;
  });
}

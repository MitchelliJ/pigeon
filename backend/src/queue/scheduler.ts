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
    SELECT e.id
    FROM emails e
    WHERE e.summary IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM jobs j
        WHERE j.type = 'summarize_classify'
          AND j.payload->>'emailId' = e.id::text
          AND j.status = 'failed'
      )
    ORDER BY e.received_at
    LIMIT 500
  `;
  await Promise.all(rows.map((row) => enqueueClassifyJob(db, String(row.id))));
}

/**
 * Atomically create immediate attempts and their delivery jobs for newly
 * classified action emails owned by active quiet-mode channel users. The
 * attempt's unique index makes concurrent scheduler scans safe.
 */
export async function scheduleImmediateDeliveries(
  db: Db,
  now: Date,
): Promise<void> {
  await db.withTx(async (tx) => {
    await tx`
      WITH inserted_attempts AS (
        INSERT INTO delivery_attempts(
          user_id, channel_id, kind, email_id, status
        )
        SELECT
          m.user_id,
          c.id,
          'immediate',
          e.id,
          'pending'
        FROM emails e
        JOIN mailboxes m ON m.id = e.mailbox_id
        JOIN delivery_settings ds ON ds.user_id = m.user_id
        JOIN channels c ON c.user_id = m.user_id
        WHERE ds.mode = 'quiet'
          AND c.status = 'active'
          AND e.category = 'requires_action'
          AND e.classified_at > ds.delivery_baseline_at
          AND e.classified_at <= ${now}
        ORDER BY c.id, e.id
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
 * Queue the latest due heartbeat for active quiet-mode channels when no
 * successful immediate delivery occurred in its preceding configured window.
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
        CROSS JOIN LATERAL (
          SELECT
            (days.local_day::date + ds.digest_time) AT TIME ZONE ds.timezone
              AS scheduled_for
          FROM generate_series(
            (due.scheduled_for AT TIME ZONE ds.timezone)::date - INTERVAL '7 days',
            (due.scheduled_for AT TIME ZONE ds.timezone)::date - INTERVAL '1 day',
            INTERVAL '1 day'
          ) AS days(local_day)
          WHERE EXTRACT(ISODOW FROM days.local_day)::smallint
                  = ANY(ds.digest_days)
          ORDER BY scheduled_for DESC
          LIMIT 1
        ) previous_slot
        WHERE ds.mode = 'quiet'
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
          FROM delivery_attempts immediate
          WHERE immediate.channel_id = candidate.channel_id
            AND immediate.kind = 'immediate'
            AND immediate.status = 'sent'
            AND immediate.sent_at > candidate.window_start
            AND immediate.sent_at <= ${now}
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
          AND due.scheduled_for > COALESCE(
            ds.last_digest_cutoff_at,
            ds.delivery_baseline_at
          )
      ),
      ranked AS (
        SELECT
          c.channel_id,
          c.scheduled_for,
          e.id AS email_id,
          e.category,
          e.summary,
          row_number() OVER (
            PARTITION BY c.channel_id, c.scheduled_for
            ORDER BY
              CASE e.category
                WHEN 'requires_action' THEN 1
                WHEN 'important' THEN 2
                WHEN 'noise' THEN 3
              END,
              e.received_at DESC,
              e.classified_at DESC,
              e.id DESC
          ) AS position,
          count(*) OVER (
            PARTITION BY c.channel_id, c.scheduled_for
          ) AS total_count
        FROM candidates c
        JOIN mailboxes m ON m.user_id = c.user_id
        JOIN emails e ON e.mailbox_id = m.id
        WHERE e.summary IS NOT NULL
          AND e.category IS NOT NULL
          AND e.classified_at > c.window_start
          AND e.classified_at <= c.scheduled_for
          AND e.received_at >= c.delivery_baseline_at
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
          email_id,
          position,
          category,
          summary
        )
        SELECT
          ia.id,
          r.email_id,
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

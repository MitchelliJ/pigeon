/*
 * Queue store (Job Queue, Workers & Scheduler PRD §3.2 FR-2..FR-5, FR-9):
 * the hand-rolled `SELECT ... FOR UPDATE SKIP LOCKED` polling queue backing
 * the `jobs` table from `db/migrations/0006_jobs.sql`. No ORM, no queue
 * library — one atomic claim query is what makes this safe under a single
 * worker process today and multiple ones later (per the PRD's non-goals).
 *
 * why jsonb_build_object: `enqueueSyncJob` builds the JSONB payload with
 * Postgres's own `jsonb_build_object(...)` rather than passing a JS object as
 * a jsonb parameter — this sidesteps `postgres.js`'s jsonb-parameter-encoding
 * gotcha entirely by letting the server construct the JSON itself.
 */
import type { Db } from "../db/index";
import type { Job, JobStatus, JobType } from "./types";

/** FR-9: a `running` job whose `locked_at` is older than this is abandoned
 * (crashed worker) and safe to reclaim. */
const VISIBILITY_TIMEOUT = "5 minutes";

/** FR-5: flat backoff constants, not env vars — same precedent as Feature 4's
 * 7-day history cap. */
const FIRST_RETRY_BACKOFF = "1 minute";
const SUBSEQUENT_RETRY_BACKOFF = "5 minutes";

/** `backoff(attempts)` from FR-5: `1 minute` after the first failure, `5
 * minutes` after every one after that. */
function backoffFor(attempts: number): string {
  return attempts <= 1 ? FIRST_RETRY_BACKOFF : SUBSEQUENT_RETRY_BACKOFF;
}

/** Raw snake_case row shape as returned by `postgres.js` for the `jobs` table. */
interface JobRow {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  status: string;
  attempts: number;
  max_attempts: number;
  run_at: string | Date;
  locked_at: string | Date | null;
  last_error: string | null;
  created_at: string | Date;
  updated_at: string | Date;
}

/** Map a raw `jobs` row to the camelCase `Job` shape. */
function toJob(row: JobRow): Job {
  return {
    id: row.id,
    type: row.type as JobType,
    payload: row.payload,
    status: row.status as JobStatus,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    runAt: new Date(row.run_at),
    lockedAt: row.locked_at === null ? null : new Date(row.locked_at),
    lastError: row.last_error,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

/**
 * Enqueue a `sync_mailbox` job for `mailboxId` (FR-2). A no-op when a
 * pending/running job already exists for that mailbox — enforced by the
 * partial unique index `idx_jobs_sync_mailbox_inflight`, which
 * `ON CONFLICT DO NOTHING` matches without needing an explicit column list.
 */
export async function enqueueSyncJob(db: Db, mailboxId: string): Promise<void> {
  await db.query`
    INSERT INTO jobs (type, payload)
    VALUES ('sync_mailbox', jsonb_build_object('mailboxId', ${mailboxId}::text))
    ON CONFLICT DO NOTHING
  `;
}

/**
 * Enqueue a `summarize_classify` job for `emailId` (LLM Processing PRD FR-4).
 * A no-op when a pending/running job already exists for that email — enforced
 * by the partial unique index `idx_jobs_summarize_classify_inflight`, which
 * `ON CONFLICT DO NOTHING` matches without needing an explicit column list.
 */
export async function enqueueClassifyJob(
  db: Db,
  emailId: string,
): Promise<void> {
  await db.query`
    INSERT INTO jobs (type, payload)
    VALUES ('summarize_classify', jsonb_build_object('emailId', ${emailId}::text))
    ON CONFLICT DO NOTHING
  `;
}

/**
 * Claim up to `limit` jobs (FR-3, FR-9): fresh `pending` work that's due, and
 * abandoned `running` work past the visibility timeout, in one atomic
 * statement so two concurrent callers never claim the same row
 * (`FOR UPDATE SKIP LOCKED`).
 */
export async function claimJobs(db: Db, limit: number): Promise<Job[]> {
  const rows = (await db.query`
    WITH claimable AS (
      SELECT id FROM jobs
      WHERE (status = 'pending' AND run_at <= now())
         OR (status = 'running' AND locked_at < now() - ${VISIBILITY_TIMEOUT}::interval)
      ORDER BY run_at
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE jobs
    SET status = 'running', locked_at = now(), attempts = attempts + 1, updated_at = now()
    FROM claimable
    WHERE jobs.id = claimable.id
    RETURNING jobs.*
  `) as unknown as JobRow[];
  return rows.map(toJob);
}

/** Mark `jobId` as succeeded (FR-4). */
export async function completeJob(db: Db, jobId: string): Promise<void> {
  await db.query`
    UPDATE jobs SET status = 'succeeded', updated_at = now() WHERE id = ${jobId}
  `;
}

/**
 * Record a job failure (FR-5): reschedule with backoff if attempts remain,
 * otherwise dead-letter it (`status = 'failed'`) and print a single
 * `console.error` line so a permanently failed job is at least visible in the
 * worker's own logs (FR-19) — the next scheduler tick re-attempts on its own.
 */
export async function failJob(
  db: Db,
  jobId: string,
  error: string,
): Promise<void> {
  const rows = (await db.query`
    SELECT attempts, max_attempts, payload FROM jobs WHERE id = ${jobId}
  `) as unknown as Array<Pick<JobRow, "attempts" | "max_attempts" | "payload">>;
  const row = rows[0];
  if (!row) {
    return;
  }

  if (row.attempts < row.max_attempts) {
    const backoff = backoffFor(row.attempts);
    await db.query`
      UPDATE jobs
      SET status = 'pending', run_at = now() + ${backoff}::interval,
          last_error = ${error}, updated_at = now()
      WHERE id = ${jobId}
    `;
    return;
  }

  await db.query`
    UPDATE jobs
    SET status = 'failed', last_error = ${error}, updated_at = now()
    WHERE id = ${jobId}
  `;
  console.error(
    `[queue] job ${jobId} dead-lettered after ${String(row.attempts)} attempts (mailboxId=${String(row.payload.mailboxId)}): ${error}`,
  );
}

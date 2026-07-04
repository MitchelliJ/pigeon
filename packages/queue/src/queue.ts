/**
 * Durable job queue on PostgreSQL. Claiming uses FOR UPDATE SKIP LOCKED so
 * any number of workers can poll the same table without stepping on each
 * other. Retries back off exponentially; jobs that exhaust max_attempts
 * land in 'failed' (dead-letter) for inspection.
 */
import type { Pool, PoolClient } from "@pigeon/db";

export interface Job<P = unknown> {
  id: string;
  type: string;
  payload: P;
  status: "pending" | "running" | "done" | "failed";
  runAt: Date;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  idempotencyKey: string | null;
}

export interface EnqueueOptions {
  /** Delay or schedule the job. Default: now. */
  runAt?: Date;
  /** Same (type, key) enqueued again is a no-op while the original exists. */
  idempotencyKey?: string;
  maxAttempts?: number;
}

/** Visibility timeout: a claimed job returns to the queue if the worker dies. */
export const LOCK_TIMEOUT_MS = 5 * 60 * 1000;
/** Base for exponential retry backoff (base * 2^attempt). */
const BACKOFF_BASE_MS = 5_000;
const BACKOFF_MAX_MS = 15 * 60 * 1000;

function rowToJob(row: Record<string, unknown>): Job {
  return {
    id: String(row.id),
    type: row.type as string,
    payload: row.payload,
    status: row.status as Job["status"],
    runAt: row.run_at as Date,
    attempts: row.attempts as number,
    maxAttempts: row.max_attempts as number,
    lastError: (row.last_error as string) ?? null,
    idempotencyKey: (row.idempotency_key as string) ?? null,
  };
}

/** Returns the job id, or null when an idempotency key suppressed the insert. */
export async function enqueue(
  db: Pool | PoolClient,
  type: string,
  payload: unknown = {},
  options: EnqueueOptions = {},
): Promise<string | null> {
  const { rows } = await db.query(
    `INSERT INTO jobs (type, payload, run_at, idempotency_key, max_attempts)
     VALUES ($1, $2, COALESCE($3, now()), $4, COALESCE($5, 5))
     ON CONFLICT (type, idempotency_key) WHERE idempotency_key IS NOT NULL
     DO NOTHING
     RETURNING id`,
    [type, JSON.stringify(payload), options.runAt ?? null, options.idempotencyKey ?? null, options.maxAttempts ?? null],
  );
  return rows.length > 0 ? String(rows[0].id) : null;
}

/** Atomically claim the next due job (optionally filtered by type). */
export async function claimJob(
  pool: Pool,
  types?: string[],
): Promise<Job | null> {
  const typeFilter = types && types.length > 0 ? "AND type = ANY($1)" : "";
  const params = types && types.length > 0 ? [types] : [];
  const { rows } = await pool.query(
    `UPDATE jobs SET
       status = 'running',
       attempts = attempts + 1,
       locked_until = now() + interval '${LOCK_TIMEOUT_MS} milliseconds',
       updated_at = now()
     WHERE id = (
       SELECT id FROM jobs
       WHERE status = 'pending' AND run_at <= now() ${typeFilter}
       ORDER BY run_at, id
       FOR UPDATE SKIP LOCKED
       LIMIT 1
     )
     RETURNING *`,
    params,
  );
  return rows.length > 0 ? rowToJob(rows[0]) : null;
}

export async function completeJob(pool: Pool, jobId: string): Promise<void> {
  await pool.query(
    `UPDATE jobs SET status = 'done', locked_until = NULL, updated_at = now()
     WHERE id = $1`,
    [jobId],
  );
}

/**
 * Record a failure: back off and retry, or dead-letter once attempts are
 * exhausted. Returns the resulting status.
 */
export async function failJob(
  pool: Pool,
  job: Pick<Job, "id" | "attempts" | "maxAttempts">,
  error: string,
): Promise<"pending" | "failed"> {
  const dead = job.attempts >= job.maxAttempts;
  const backoffMs = Math.min(
    BACKOFF_BASE_MS * 2 ** (job.attempts - 1),
    BACKOFF_MAX_MS,
  );
  await pool.query(
    `UPDATE jobs SET
       status = $2,
       run_at = now() + interval '${backoffMs} milliseconds',
       locked_until = NULL,
       last_error = $3,
       updated_at = now()
     WHERE id = $1`,
    [job.id, dead ? "failed" : "pending", error.slice(0, 4000)],
  );
  return dead ? "failed" : "pending";
}

/** Return crashed workers' jobs (lock expired while 'running') to the queue. */
export async function reapStuckJobs(pool: Pool): Promise<number> {
  const result = await pool.query(
    `UPDATE jobs SET status = 'pending', locked_until = NULL, updated_at = now()
     WHERE status = 'running' AND locked_until < now()`,
  );
  return result.rowCount ?? 0;
}

/** Queue depth by status — used by ops/readiness surfaces. */
export async function countJobs(pool: Pool): Promise<Record<string, number>> {
  const { rows } = await pool.query(
    "SELECT status, count(*)::int AS n FROM jobs GROUP BY status",
  );
  const out: Record<string, number> = { pending: 0, running: 0, done: 0, failed: 0 };
  for (const row of rows) out[row.status] = row.n;
  return out;
}

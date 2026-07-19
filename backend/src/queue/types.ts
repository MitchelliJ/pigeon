/*
 * Shared types for the `queue` module (Job Queue, Workers & Scheduler PRD
 * §3.1 FR-1, §3.2). These are the TS-facing, camelCase mirror of the
 * snake_case `jobs` table columns from `db/migrations/0006_jobs.sql` — `store`
 * maps raw query rows into this shape at the one boundary that reads them.
 */

/** The closed set of job types. Extended by later features' own migrations. */
export type JobType = "sync_mailbox" | "summarize_classify" | "deliver_channel";

/** The full lifecycle of a job: queued, claimed, or one of two terminal states. */
export type JobStatus = "pending" | "running" | "succeeded" | "failed";

/** A single row of the `jobs` table, camelCase for TS callers. */
export interface Job {
  id: string;
  type: JobType;
  payload: Record<string, unknown>;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  runAt: Date;
  lockedAt: Date | null;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}

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
 */
export async function enqueueDueClassifyJobs(db: Db): Promise<void> {
  const rows = await db.query`
    SELECT id FROM emails WHERE summary IS NULL ORDER BY received_at LIMIT 500
  `;
  await Promise.all(rows.map((row) => enqueueClassifyJob(db, String(row.id))));
}

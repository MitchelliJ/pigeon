/**
 * Quota enforcement ("quotas at the edge"): tier limits are checked when
 * work is admitted (mailbox connect, LLM processing), never after the spend.
 */
import type { Pool, PoolClient } from "@pigeon/db";
import { tierLimits, type TierLimits } from "@pigeon/shared";

export { tierLimits, TIERS, type TierLimits, type PlanTier } from "@pigeon/shared";

/** Calendar-month key, e.g. "2026-07" (UTC — one consistent billing clock). */
export function currentPeriod(now: Date = new Date()): string {
  return now.toISOString().slice(0, 7);
}

export interface Usage {
  period: string;
  emailsProcessed: number;
  mailboxes: number;
  limits: TierLimits;
}

export async function getUsage(pool: Pool, userId: string, tier: string): Promise<Usage> {
  const period = currentPeriod();
  const [counters, mailboxes] = await Promise.all([
    pool.query(
      "SELECT emails_processed FROM usage_counters WHERE user_id = $1 AND period = $2",
      [userId, period],
    ),
    pool.query(
      "SELECT count(*)::int AS n FROM mailboxes WHERE user_id = $1 AND status != 'disconnected'",
      [userId],
    ),
  ]);
  return {
    period,
    emailsProcessed: counters.rows[0]?.emails_processed ?? 0,
    mailboxes: mailboxes.rows[0].n,
    limits: tierLimits(tier),
  };
}

/** True when the user may connect one more mailbox. */
export async function canAddMailbox(pool: Pool, userId: string, tier: string): Promise<boolean> {
  const usage = await getUsage(pool, userId, tier);
  return usage.mailboxes < usage.limits.maxMailboxes;
}

/** True when this month's LLM budget still has room. */
export async function canProcessEmail(pool: Pool, userId: string, tier: string): Promise<boolean> {
  const { rows } = await pool.query(
    "SELECT emails_processed FROM usage_counters WHERE user_id = $1 AND period = $2",
    [userId, currentPeriod()],
  );
  const used = rows[0]?.emails_processed ?? 0;
  return used < tierLimits(tier).monthlyEmailQuota;
}

/** Count one processed email (call inside the processing transaction). */
export async function incrementEmailsProcessed(
  db: Pool | PoolClient,
  userId: string,
  now: Date = new Date(),
): Promise<void> {
  await db.query(
    `INSERT INTO usage_counters (user_id, period, emails_processed)
     VALUES ($1, $2, 1)
     ON CONFLICT (user_id, period)
     DO UPDATE SET emails_processed = usage_counters.emails_processed + 1`,
    [userId, currentPeriod(now)],
  );
}

/*
 * Tier -> sync-interval placeholder lookup (Job Queue, Workers & Scheduler
 * PRD §3.2 FR-10). This is a placeholder plan catalog so the scheduler's
 * cadence is plan-configurable now, ahead of Feature 9 owning the real tier
 * limits/plan catalog. Do not grow this into a full plan model here.
 */

export const DEFAULT_SYNC_INTERVAL_MINUTES = 5;

const TIER_SYNC_INTERVAL_MINUTES: Record<string, number> = {
  free: 30,
};

export function intervalForTier(tier: string): number {
  return TIER_SYNC_INTERVAL_MINUTES[tier] ?? DEFAULT_SYNC_INTERVAL_MINUTES;
}

/*
 * Dashboard assembly route (Inbox Connectors & Provider Abstraction PRD
 * §3.2.5, FR-10).
 *
 * `dashboardRoutes(db)` mounts `GET /api/dashboard` behind `requireAuth(db)`
 * and assembles the `DashboardData` payload the frontend dashboard reads in
 * one shot. Only `user` and `accounts` are real today:
 *
 * - `user.plan` is derived from `tierLimits(sessionUser.tier)` — a cheap,
 *   honest read of the tier the user already has. There is no billing yet
 *   (Feature 10 owns that), so `nextBillingDate` is always `null` and
 *   `canUpgrade` is just "not already on the top tier" (`TIERS.team`).
 * - `accounts` is a real `mailboxes` read, scoped to the caller. It
 *   deliberately selects only display-safe columns — never
 *   `password_ciphertext`, `username`, `host`, `port`, or `tls` — so the
 *   dashboard response can never leak secret-adjacent connection details.
 *   `unread` is hardcoded to 0 until Feature 4 populates real counts.
 *
 * Everything else is an inert placeholder, owned by a later feature:
 * `stats` (Feature 6), `emails` (Feature 4/6), `channels`/`digest`
 * (Feature 7), `lastSync` (Feature 4).
 */
import { Hono } from "hono";
import { tierLimits } from "@pigeon/shared";
import { requireAuth } from "../auth/middleware";
import type { AuthVariables } from "../auth/middleware";
import type { Db } from "../db/index";
import type { DashboardData, EmailAccount, Plan } from "@pigeon/shared";

/** Derive the signed-in user's `Plan` from their tier — no billing yet (Feature 10). */
function planFor(tier: string): Plan {
  const limits = tierLimits(tier);
  return {
    tier: limits.tier,
    name: limits.name,
    price: limits.priceLabel,
    inboxLimit: limits.maxMailboxes,
    nextBillingDate: null,
    canUpgrade: limits.tier !== "team",
  };
}

/** Load the caller's connected mailboxes, shaped for the dashboard (no secrets). */
async function loadAccounts(db: Db, userId: string): Promise<EmailAccount[]> {
  const rows = await db.query`
    SELECT id, provider, label, address, protocol, status
    FROM mailboxes
    WHERE user_id = ${userId}
    ORDER BY created_at
  `;
  return rows.map((row) => ({
    id: String(row.id),
    provider: row.provider as EmailAccount["provider"],
    label: String(row.label),
    address: String(row.address),
    protocol: row.protocol as EmailAccount["protocol"],
    status: row.status as EmailAccount["status"],
    unread: 0, // Feature 4 owns real unread counts.
  }));
}

/** Mount `GET /api/dashboard` onto a fresh Hono app bound to `db`. */
export function dashboardRoutes(db: Db): Hono<{ Variables: AuthVariables }> {
  const app = new Hono<{ Variables: AuthVariables }>();

  app.get("/api/dashboard", requireAuth(db), async (c) => {
    const sessionUser = c.get("sessionUser");
    const accounts = await loadAccounts(db, sessionUser.id);

    const dashboard: DashboardData = {
      user: {
        name: sessionUser.name,
        email: sessionUser.email,
        plan: planFor(sessionUser.tier),
      },
      accounts,
      stats: { urgent: 0, important: 0, everything: 0 }, // Feature 6 owns real stats.
      emails: [], // Feature 4/6 owns real triaged emails.
      channels: [], // Feature 7 owns real notification channels.
      digest: {
        enabled: false,
        time: "08:00",
        days: [],
        channelId: "",
        lastSent: "Never",
      }, // Feature 7 owns the real digest config.
      lastSync: "Never", // Feature 4 owns the real last-sync timestamp.
    };

    return c.json(dashboard, 200);
  });

  return app;
}

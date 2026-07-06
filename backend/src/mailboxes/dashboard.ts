/*
 * Dashboard assembly route (Inbox Connectors & Provider Abstraction PRD
 * §3.2.5, FR-10; Incremental Sync Engine & Watermarks PRD §3.4, FR-11/FR-12).
 *
 * `dashboardRoutes(db)` mounts `GET /api/dashboard` behind `requireAuth(db)`
 * and assembles the `DashboardData` payload the frontend dashboard reads in
 * one shot. `user`, `accounts`, and `lastSync` are real today:
 *
 * - `user.plan` is derived from `tierLimits(sessionUser.tier)` — a cheap,
 *   honest read of the tier the user already has. There is no billing yet
 *   (Feature 10 owns that), so `nextBillingDate` is always `null` and
 *   `canUpgrade` is just "not already on the top tier" (`TIERS.team`).
 * - `accounts` is a real `mailboxes` read, scoped to the caller. It
 *   deliberately selects only display-safe columns — never
 *   `password_ciphertext`, `username`, `host`, `port`, or `tls` — so the
 *   dashboard response can never leak secret-adjacent connection details.
 *   `unread` is a real unseen-`emails` count, but only for `protocol =
 *   'imap'` mailboxes: POP3 has no read/unread flag at all (FR-12), so POP3
 *   mailboxes always report 0 without running the count query.
 * - `lastSync` is the most recent `mailboxes.last_synced_at` across the
 *   caller's mailboxes, formatted as a short relative-time string (or
 *   "Never" if no mailbox has ever synced).
 *
 * Everything else is an inert placeholder, owned by a later feature:
 * `stats` (Feature 6), `emails` (Feature 4/6), `channels`/`digest`
 * (Feature 7).
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

/**
 * Count unseen emails per IMAP mailbox in one grouped query. POP3 mailboxes
 * are deliberately excluded from `mailboxIds` by the caller — POP3 has no
 * read/unread flag, so counting its `emails` rows would be meaningless
 * (FR-12) — and never appear in the returned map.
 */
async function loadUnreadCounts(
  db: Db,
  mailboxIds: string[],
): Promise<Map<string, number>> {
  if (mailboxIds.length === 0) return new Map();

  const rows = await db.query`
    SELECT mailbox_id, COUNT(*) FILTER (WHERE seen = false) AS unread
    FROM emails
    WHERE mailbox_id = ANY(${mailboxIds}::uuid[])
    GROUP BY mailbox_id
  `;
  return new Map(
    rows.map((row) => [String(row.mailbox_id), Number(row.unread)]),
  );
}

/** Load the caller's connected mailboxes, shaped for the dashboard (no secrets). */
async function loadAccounts(db: Db, userId: string): Promise<EmailAccount[]> {
  const rows = await db.query`
    SELECT id, provider, label, address, protocol, status
    FROM mailboxes
    WHERE user_id = ${userId}
    ORDER BY created_at
  `;

  const imapMailboxIds = rows
    .filter((row) => row.protocol === "imap")
    .map((row) => String(row.id));
  const unreadCounts = await loadUnreadCounts(db, imapMailboxIds);

  return rows.map((row) => {
    const id = String(row.id);
    const protocol = row.protocol as EmailAccount["protocol"];
    return {
      id,
      provider: row.provider as EmailAccount["provider"],
      label: String(row.label),
      address: String(row.address),
      protocol,
      status: row.status as EmailAccount["status"],
      unread: protocol === "imap" ? (unreadCounts.get(id) ?? 0) : 0,
    };
  });
}

/**
 * Most recent `mailboxes.last_synced_at` across the caller's mailboxes, or
 * `null` if the user has no mailboxes or none has ever synced.
 */
async function loadLastSyncedAt(db: Db, userId: string): Promise<Date | null> {
  const rows = await db.query`
    SELECT MAX(last_synced_at) AS last_synced_at
    FROM mailboxes
    WHERE user_id = ${userId}
  `;
  return (rows[0]?.last_synced_at as Date | null) ?? null;
}

/**
 * Format `date` relative to now as a short string ("30s ago", "2m ago", "1h
 * ago", "3d ago"). Plain if/else on elapsed milliseconds — no date library
 * needed for this granularity.
 */
function formatRelativeTime(date: Date): string {
  const elapsedMs = Date.now() - date.getTime();
  const elapsedSeconds = Math.floor(elapsedMs / 1000);
  const elapsedMinutes = Math.floor(elapsedMs / (60 * 1000));
  const elapsedHours = Math.floor(elapsedMs / (60 * 60 * 1000));
  const elapsedDays = Math.floor(elapsedMs / (24 * 60 * 60 * 1000));

  if (elapsedSeconds < 60) return `${elapsedSeconds}s ago`;
  if (elapsedMinutes < 60) return `${elapsedMinutes}m ago`;
  if (elapsedHours < 24) return `${elapsedHours}h ago`;
  return `${elapsedDays}d ago`;
}

/** Mount `GET /api/dashboard` onto a fresh Hono app bound to `db`. */
export function dashboardRoutes(db: Db): Hono<{ Variables: AuthVariables }> {
  const app = new Hono<{ Variables: AuthVariables }>();

  app.get("/api/dashboard", requireAuth(db), async (c) => {
    const sessionUser = c.get("sessionUser");
    const accounts = await loadAccounts(db, sessionUser.id);
    const lastSyncedAt = await loadLastSyncedAt(db, sessionUser.id);

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
      lastSync: lastSyncedAt ? formatRelativeTime(lastSyncedAt) : "Never",
    };

    return c.json(dashboard, 200);
  });

  return app;
}

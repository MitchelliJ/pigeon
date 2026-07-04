/**
 * /api/dashboard — the one aggregate payload the web app renders from,
 * matching the `DashboardData` shape in @pigeon/shared (which the UI was
 * prototyped against).
 */
import { Hono } from "hono";
import type {
  Channel as SharedChannel,
  DashboardData,
  Digest,
  Email,
  EmailAccount,
  Plan,
  Priority,
  Weekday,
} from "@pigeon/shared";
import { TIERS, tierLimits, type PlanTier } from "@pigeon/shared";
import { listChannels, getDeliverySettings, openChannelConfig } from "@pigeon/deliver";
import { listMailboxes } from "@pigeon/mail";
import type { AppEnv } from "../app.js";
import { requireAuth } from "../auth/middleware.js";

/** "2m ago" style relative label; the UI shows these verbatim. */
export function relative(date: Date | null | undefined, now = Date.now()): string {
  if (!date) return "never";
  const diff = Math.max(0, now - date.getTime());
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "yesterday" : `${days}d ago`;
}

function planFromTier(tier: string): Plan {
  const limits = tierLimits(tier);
  return {
    tier: limits.tier as PlanTier,
    name: limits.name,
    price: limits.priceLabel,
    inboxLimit: limits.maxMailboxes,
    nextBillingDate: null, // filled when a real Mollie subscription runs
    canUpgrade: limits.tier !== "team",
  };
}

export const dashboardRoutes = new Hono<AppEnv>()
  .use("*", requireAuth)
  .get("/", async (c) => {
    const { pool, vault } = c.get("deps");
    const user = c.get("user");

    const [mailboxes, channels, settings, emailRows, statRows] = await Promise.all([
      listMailboxes(pool, user.id),
      listChannels(pool, user.id),
      getDeliverySettings(pool, user.id),
      pool.query(
        `SELECT id, mailbox_id, from_name, from_address, subject, body_text,
                summary, priority, needs_attention, suggested_action, received_at
         FROM emails WHERE user_id = $1
         ORDER BY received_at DESC LIMIT 30`,
        [user.id],
      ),
      pool.query(
        `SELECT COALESCE(priority, 'everything') AS priority, count(*)::int AS n
         FROM emails
         WHERE user_id = $1 AND received_at > now() - interval '7 days'
         GROUP BY 1`,
        [user.id],
      ),
    ]);

    const unreadRows = await pool.query(
      `SELECT mailbox_id, count(*)::int AS n
       FROM emails
       WHERE user_id = $1 AND needs_attention = true
         AND received_at > now() - interval '7 days'
       GROUP BY mailbox_id`,
      [user.id],
    );
    const unread = new Map<string, number>(
      unreadRows.rows.map((r) => [r.mailbox_id as string, r.n as number]),
    );

    const stats = { urgent: 0, important: 0, everything: 0 };
    for (const row of statRows.rows) {
      if (row.priority in stats) stats[row.priority as Priority] = row.n;
    }

    const accounts: EmailAccount[] = mailboxes.map((mb) => ({
      id: mb.id,
      provider: (["gmail", "outlook", "icloud", "fastmail", "imap", "mock"].includes(mb.provider)
        ? mb.provider
        : "imap") as EmailAccount["provider"],
      label: mb.label || mb.address,
      address: mb.address,
      protocol: mb.protocol as EmailAccount["protocol"],
      status: mb.status,
      unread: unread.get(mb.id) ?? 0,
    }));

    const sharedChannels: SharedChannel[] = channels.map((ch) => {
      let hint = "configured";
      try {
        const config = openChannelConfig(vault, ch);
        const url = typeof config.webhookUrl === "string" ? config.webhookUrl : "";
        const phone = typeof config.phoneNumber === "string" ? config.phoneNumber : "";
        hint = url ? `…${url.slice(-8)}` : phone || "configured";
      } catch {
        // unreadable sealed config; keep the placeholder
      }
      return {
        id: ch.id,
        kind: ch.kind,
        label: ch.label || ch.kind,
        webhookUrl: hint, // masked — the UI shows it as an identifier only
        minPriority: ch.minPriority,
        enabled: ch.enabled,
      };
    });

    const digest: Digest = {
      enabled: settings.digestEnabled,
      time: settings.digestTime,
      days: settings.digestDays as Weekday[],
      channelId: settings.digestChannelId ?? "",
      lastSent: relative(settings.lastDigestAt),
    };

    const emails: Email[] = emailRows.rows.map((row) => ({
      id: row.id,
      accountId: row.mailbox_id,
      fromName: row.from_name || row.from_address || "Unknown",
      fromAddress: row.from_address,
      subject: row.subject,
      summary: row.summary ?? "(waiting for summary…)",
      body: row.body_text,
      priority: (row.priority ?? "everything") as Priority,
      receivedAt: relative(row.received_at),
      needsAttention: Boolean(row.needs_attention),
      suggestedAction: row.suggested_action ?? undefined,
    }));

    const lastSyncDates = mailboxes
      .map((mb) => mb.lastSyncedAt)
      .filter((d): d is Date => d !== null)
      .sort((a, b) => b.getTime() - a.getTime());

    const data: DashboardData = {
      user: {
        name: user.name || user.email.split("@")[0] || "there",
        email: user.email,
        plan: planFromTier(user.tier),
      },
      stats,
      emails,
      accounts,
      channels: sharedChannels,
      digest,
      lastSync: relative(lastSyncDates[0] ?? null),
    };
    return c.json(data);
  });

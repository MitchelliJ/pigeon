/**
 * Delivery engine.
 *
 * Immediate path: after triage, an email goes NOW to every enabled channel
 * whose min_priority it meets. Digest path: everything not delivered
 * immediately is rolled into the user's daily digest. Both paths dedupe
 * through the `deliveries` table, so retries never double-notify.
 */
import type { Logger } from "@pigeon/config";
import type { Pool } from "@pigeon/db";
import type { Vault } from "@pigeon/vault";
import { getConnector } from "./connectors/index.js";
import {
  listChannels,
  openChannelConfig,
  getDeliverySettings,
  type Channel,
} from "./store.js";
import { userClock } from "./time.js";
import {
  ChannelSendError,
  PRIORITY_ORDER,
  type MessageLine,
  type OutboundMessage,
  type Priority,
} from "./types.js";

/** True when this send already happened (dedupe hit). */
async function alreadySent(pool: Pool, dedupeKey: string): Promise<boolean> {
  const { rows } = await pool.query(
    "SELECT status FROM deliveries WHERE dedupe_key = $1",
    [dedupeKey],
  );
  return rows.length > 0 && rows[0].status === "sent";
}

async function recordDelivery(
  pool: Pool,
  entry: {
    userId: string;
    channelId: string | null;
    kind: OutboundMessage["kind"];
    emailId?: string;
    dedupeKey: string;
    status: "sent" | "failed";
    detail?: string;
  },
): Promise<void> {
  await pool.query(
    `INSERT INTO deliveries (user_id, channel_id, kind, email_id, dedupe_key, status, detail)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (dedupe_key) DO UPDATE SET
       status = EXCLUDED.status, detail = EXCLUDED.detail, created_at = now()`,
    [
      entry.userId,
      entry.channelId,
      entry.kind,
      entry.emailId ?? null,
      entry.dedupeKey,
      entry.status,
      entry.detail ?? null,
    ],
  );
}

export async function sendToChannel(
  pool: Pool,
  vault: Vault,
  channel: Channel,
  message: OutboundMessage,
  dedupeKey: string,
  emailId?: string,
): Promise<"sent" | "skipped"> {
  if (await alreadySent(pool, dedupeKey)) return "skipped";
  const connector = getConnector(channel.kind);
  const config = openChannelConfig(vault, channel);
  try {
    await connector.send(config, message);
  } catch (err) {
    await recordDelivery(pool, {
      userId: channel.userId,
      channelId: channel.id,
      kind: message.kind,
      emailId,
      dedupeKey,
      status: "failed",
      detail: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
  await recordDelivery(pool, {
    userId: channel.userId,
    channelId: channel.id,
    kind: message.kind,
    emailId,
    dedupeKey,
    status: "sent",
  });
  return "sent";
}

interface EmailRow {
  id: string;
  user_id: string;
  from_name: string;
  from_address: string;
  subject: string;
  summary: string | null;
  priority: Priority | null;
  suggested_action: string | null;
  mailbox_label: string;
  delivered_immediate_at: Date | null;
}

function emailToLine(email: EmailRow): MessageLine {
  return {
    fromName: email.from_name || email.from_address,
    subject: email.subject,
    summary: email.summary ?? email.subject,
    priority: email.priority ?? "everything",
    suggestedAction: email.suggested_action ?? undefined,
    mailboxLabel: email.mailbox_label || undefined,
  };
}

/**
 * delivery.route job body: send one processed email to every enabled channel
 * whose threshold it meets. Retryable failures rethrow (job backoff);
 * non-retryable ones (dead webhook) are recorded and skipped.
 */
export async function routeEmail(
  pool: Pool,
  vault: Vault,
  logger: Logger,
  emailId: string,
): Promise<{ sent: number; skipped: number }> {
  const { rows } = await pool.query(
    `SELECT e.id, e.user_id, e.from_name, e.from_address, e.subject, e.summary,
            e.priority, e.suggested_action, e.delivered_immediate_at,
            COALESCE(m.label, m.address, '') AS mailbox_label
     FROM emails e LEFT JOIN mailboxes m ON m.id = e.mailbox_id
     WHERE e.id = $1 AND e.processed_at IS NOT NULL`,
    [emailId],
  );
  if (rows.length === 0) {
    logger.warn("delivery.route: email missing or unprocessed", { emailId });
    return { sent: 0, skipped: 0 };
  }
  const email = rows[0] as EmailRow;
  const priority = email.priority ?? "everything";

  const channels = (await listChannels(pool, email.user_id)).filter(
    (ch) => ch.enabled && PRIORITY_ORDER[priority] >= PRIORITY_ORDER[ch.minPriority],
  );

  let sent = 0;
  let skipped = 0;
  const retryableErrors: string[] = [];
  for (const channel of channels) {
    const message: OutboundMessage = {
      kind: "immediate",
      title: priority === "urgent" ? "Needs you now" : "Heads up",
      lines: [emailToLine(email)],
    };
    try {
      const outcome = await sendToChannel(
        pool,
        vault,
        channel,
        message,
        `immediate:${emailId}:${channel.id}`,
        emailId,
      );
      outcome === "sent" ? sent++ : skipped++;
    } catch (err) {
      if (err instanceof ChannelSendError && !err.retryable) {
        logger.error("channel permanently unreachable, skipping", {
          channelId: channel.id,
          error: err.message,
        });
        skipped++;
      } else {
        retryableErrors.push(err instanceof Error ? err.message : String(err));
      }
    }
  }

  if (sent > 0) {
    await pool.query(
      "UPDATE emails SET delivered_immediate_at = now() WHERE id = $1 AND delivered_immediate_at IS NULL",
      [emailId],
    );
  }
  if (retryableErrors.length > 0) {
    throw new Error(`immediate delivery incomplete: ${retryableErrors.join("; ")}`);
  }
  return { sent, skipped };
}

const DIGEST_MAX_LINES = 20;

/**
 * digest.send job body: roll up everything processed-but-undigested (and not
 * already pushed immediately), send it to the digest channel, mark it
 * digested. Empty digest + quiet_reassurance → "all quiet" note instead
 * (RAMBLINGS: tell users Pigeon is alive, not silent-broken).
 */
export async function sendDigest(
  pool: Pool,
  vault: Vault,
  logger: Logger,
  userId: string,
  now: Date = new Date(),
): Promise<"sent" | "reassured" | "skipped"> {
  const settings = await getDeliverySettings(pool, userId);
  if (!settings.digestEnabled || !settings.digestChannelId) return "skipped";
  const channels = await listChannels(pool, userId);
  const channel = channels.find((c) => c.id === settings.digestChannelId);
  if (!channel) {
    logger.warn("digest channel vanished", { userId });
    return "skipped";
  }
  const dateKey = userClock(settings.timezone, now).dateKey;

  const { rows } = await pool.query(
    `SELECT e.id, e.user_id, e.from_name, e.from_address, e.subject, e.summary,
            e.priority, e.suggested_action, e.delivered_immediate_at,
            COALESCE(m.label, m.address, '') AS mailbox_label
     FROM emails e LEFT JOIN mailboxes m ON m.id = e.mailbox_id
     WHERE e.user_id = $1
       AND e.processed_at IS NOT NULL
       AND e.digested_at IS NULL
       AND e.delivered_immediate_at IS NULL
     ORDER BY CASE e.priority WHEN 'urgent' THEN 3 WHEN 'important' THEN 2 ELSE 1 END DESC,
              e.received_at DESC`,
    [userId],
  );
  const emails = rows as EmailRow[];

  if (emails.length === 0) {
    // A retried job after a successful digest must not follow up with a
    // bogus "all quiet" — check whether today's digest already went out.
    if (await alreadySent(pool, `digest:${userId}:${dateKey}`)) return "skipped";
    let outcome: "reassured" | "skipped" = "skipped";
    if (settings.quietReassurance) {
      await sendToChannel(
        pool,
        vault,
        channel,
        {
          kind: "reassurance",
          title: "All quiet 🍃",
          lines: [],
          footer:
            "Nothing needed your attention since the last digest. Pigeon is watching your inboxes and everything is working fine.",
        },
        `reassurance:${userId}:${dateKey}`,
      );
      outcome = "reassured";
    }
    await pool.query(
      "UPDATE delivery_settings SET last_digest_at = $2 WHERE user_id = $1",
      [userId, now],
    );
    return outcome;
  }

  const lines = emails.slice(0, DIGEST_MAX_LINES).map(emailToLine);
  const extra = emails.length - lines.length;
  await sendToChannel(
    pool,
    vault,
    channel,
    {
      kind: "digest",
      title: `Your daily digest — ${emails.length} email${emails.length === 1 ? "" : "s"}`,
      lines,
      footer: extra > 0 ? `+${extra} more in your dashboard` : undefined,
    },
    `digest:${userId}:${dateKey}`,
  );

  await pool.query(
    `UPDATE emails SET digested_at = $2 WHERE id = ANY($1::uuid[])`,
    [emails.map((e) => e.id), now],
  );
  await pool.query(
    "UPDATE delivery_settings SET last_digest_at = $2 WHERE user_id = $1",
    [userId, now],
  );
  logger.info("digest sent", { userId, emails: emails.length });
  return "sent";
}

/*
 * Provider-neutral channel delivery job handler. Attempts and digest items are
 * durable snapshots, so retries rebuild the same message while connector
 * results decide whether the queue should retry or complete permanently.
 */
import type { Category } from "@pigeon/shared";

import type { ChannelRegistry } from "../../channels/registry";
import type {
  ChannelConnector,
  DeliveryMessage,
  DeliverySummaryItem,
  SendResult,
} from "../../channels/types";
import type { Db, TxClient } from "../../db/index";
import type { Vault } from "../../vault/index";

interface DeliveryAttemptRow {
  id: string;
  user_id: string;
  channel_id: string;
  kind: "immediate" | "digest" | "heartbeat";
  message_id: string | null;
  scheduled_for: Date | string | null;
  window_start: Date | string | null;
  window_end: Date | string | null;
  status: "pending" | "sent" | "failed";
  omitted_count: number;
  channel_kind: string;
  channel_status: "active" | "error";
  config_encrypted: string;
}

const CATEGORIES = new Set<Category>(["requires_action", "important", "noise"]);
const INVALID_CHANNEL_CONFIG = "Invalid channel configuration";
const INVALID_DELIVERY_PAYLOAD = "Invalid delivery payload";
const STALE_HEARTBEAT = "Heartbeat is stale or superseded";
const SAFE_CONNECTOR_NAME = "[A-Za-z][A-Za-z0-9 ._-]{0,63}";
const SAFE_CONNECTOR_FAILURE_REASON = new RegExp(
  `^(?:${SAFE_CONNECTOR_NAME} request failed|` +
    `${SAFE_CONNECTOR_NAME} responded with HTTP \\d{3})$`,
);

/** Send one durable delivery attempt, resolving only for terminal outcomes. */
export async function handleDeliverChannelJob(
  db: Db,
  vault: Vault,
  payload: { deliveryAttemptId: string },
  registry: ChannelRegistry,
): Promise<void> {
  const attempt = await loadAttempt(db, payload.deliveryAttemptId);
  if (attempt === undefined) {
    throw new Error("delivery attempt not found");
  }

  // Queue completion can race a worker crash. Terminal attempts must never
  // create another external side effect when that job is reclaimed.
  if (attempt.status !== "pending") {
    return;
  }

  if (attempt.channel_status !== "active") {
    await markPermanentFailure(db, attempt, "Channel is not active", false);
    return;
  }

  const message = await buildMessage(db, attempt);
  if (message === undefined) {
    await markPermanentFailure(db, attempt, INVALID_DELIVERY_PAYLOAD, false);
    return;
  }

  if (
    attempt.kind === "heartbeat" &&
    !(await isHeartbeatCurrent(db, attempt))
  ) {
    await markPermanentFailure(db, attempt, STALE_HEARTBEAT, false);
    return;
  }

  let connector: ChannelConnector;
  let config: unknown;
  try {
    connector = registry.get(attempt.channel_kind);
    const plaintext = vault.open(attempt.config_encrypted);
    config = connector.validateConfig(JSON.parse(plaintext) as unknown);
  } catch {
    await markPermanentFailure(db, attempt, INVALID_CHANNEL_CONFIG, true);
    return;
  }

  let result: SendResult;
  try {
    result = await connector.send(config, message);
  } catch {
    // Connector implementations return sanitized SendResult failures. An
    // unexpected throw may contain provider details, so expose only fixed copy.
    throw new Error("Channel delivery failed");
  }

  if (result.ok) {
    await markSent(db, attempt, result.providerMessageId);
    return;
  }

  const reason = sanitizeFailureReason(result.reason);
  if (result.retryable) {
    // Do not write attempt error state for transient failures: the queue owns
    // retry timing and its sanitized last_error value.
    throw new Error(reason);
  }

  await markPermanentFailure(
    db,
    attempt,
    reason,
    isInvalidChannelFailure(result, reason),
  );
}

async function loadAttempt(
  db: Db,
  deliveryAttemptId: string,
): Promise<DeliveryAttemptRow | undefined> {
  const rows = await db.query`
    SELECT
      da.id,
      da.user_id,
      da.channel_id,
      da.kind,
      da.message_id,
      da.scheduled_for,
      da.window_start,
      da.window_end,
      da.status,
      da.omitted_count,
      c.kind AS channel_kind,
      c.status AS channel_status,
      c.config_encrypted
    FROM delivery_attempts da
    JOIN channels c
      ON c.id = da.channel_id
     AND c.user_id = da.user_id
    WHERE da.id = ${deliveryAttemptId}
    LIMIT 1
  `;
  return rows[0] as unknown as DeliveryAttemptRow | undefined;
}

async function buildMessage(
  db: Db,
  attempt: DeliveryAttemptRow,
): Promise<DeliveryMessage | undefined> {
  if (attempt.kind === "heartbeat") {
    return { type: "heartbeat" };
  }

  // Quiet mode no longer schedules new immediate attempts, but persisted
  // legacy rows must keep delivering correctly until they age out.
  if (attempt.kind === "immediate") {
    const rows = await db.query`
      SELECT m.category, m.summary
      FROM messages m
      WHERE m.id = ${attempt.message_id} AND m.user_id = ${attempt.user_id}
      LIMIT 1
    `;
    const row = rows[0];
    if (
      row === undefined ||
      !isCategory(row.category) ||
      typeof row.summary !== "string"
    ) {
      return undefined;
    }

    return {
      type: "immediate",
      category: row.category,
      summary: row.summary,
    };
  }

  const rows = await db.query`
    SELECT category, summary
    FROM digest_items
    WHERE delivery_attempt_id = ${attempt.id}
    ORDER BY position
  `;
  if (rows.length === 0) {
    return { type: "empty_digest" };
  }

  const items: DeliverySummaryItem[] = [];
  for (const row of rows) {
    if (!isCategory(row.category) || typeof row.summary !== "string") {
      return undefined;
    }
    items.push({ category: row.category, summary: row.summary });
  }

  return {
    type: "digest",
    items,
    omittedCount: attempt.omitted_count,
  };
}

async function isHeartbeatCurrent(
  db: Db,
  attempt: DeliveryAttemptRow,
): Promise<boolean> {
  const rows = await db.query`
    SELECT EXISTS (
      SELECT 1
      FROM delivery_settings ds
      WHERE ds.user_id = ${attempt.user_id}
        AND ds.mode = 'quiet'
        AND ${attempt.scheduled_for}::timestamptz > ds.delivery_baseline_at
        AND NOT EXISTS (
          SELECT 1
          FROM delivery_attempts recent_user_facing_activity
          WHERE recent_user_facing_activity.channel_id = ${attempt.channel_id}
            AND (
              recent_user_facing_activity.kind = 'immediate'
              OR (
                recent_user_facing_activity.kind = 'digest'
                AND recent_user_facing_activity.message_id IS NOT NULL
              )
            )
            AND recent_user_facing_activity.status = 'sent'
            AND recent_user_facing_activity.sent_at
                  > ${attempt.window_start}::timestamptz
            AND recent_user_facing_activity.sent_at <= now()
        )
    ) AS is_current
  `;
  return rows[0]?.is_current === true;
}

async function markSent(
  db: Db,
  attempt: DeliveryAttemptRow,
  providerMessageId: string | undefined,
): Promise<void> {
  await db.withTx(async (tx) => {
    const updated = await tx`
      UPDATE delivery_attempts
      SET
        status = 'sent',
        provider_message_id = ${providerMessageId ?? null},
        last_error = NULL,
        sent_at = now(),
        updated_at = now()
      WHERE id = ${attempt.id} AND status = 'pending'
      RETURNING id
    `;

    if (
      updated.length > 0 &&
      attempt.kind === "digest" &&
      attempt.window_end !== null
    ) {
      await tx`
        UPDATE delivery_settings
        SET last_digest_cutoff_at = ${attempt.window_end}, updated_at = now()
        WHERE user_id = ${attempt.user_id}
      `;
    }
  });
}

async function markPermanentFailure(
  db: Db,
  attempt: DeliveryAttemptRow,
  reason: string,
  disableChannel: boolean,
): Promise<void> {
  await db.withTx(async (tx) => {
    const updated = await markAttemptFailed(tx, attempt.id, reason);
    if (disableChannel && updated) {
      await tx`
        UPDATE channels
        SET status = 'error', last_error = ${reason}, updated_at = now()
        WHERE id = ${attempt.channel_id} AND user_id = ${attempt.user_id}
      `;
    }
  });
}

async function markAttemptFailed(
  tx: TxClient,
  attemptId: string,
  reason: string,
): Promise<boolean> {
  const rows = await tx`
    UPDATE delivery_attempts
    SET status = 'failed', last_error = ${reason}, updated_at = now()
    WHERE id = ${attemptId} AND status = 'pending'
    RETURNING id
  `;
  return rows.length > 0;
}

function isCategory(value: unknown): value is Category {
  return typeof value === "string" && CATEGORIES.has(value as Category);
}

function sanitizeFailureReason(reason: string): string {
  return SAFE_CONNECTOR_FAILURE_REASON.test(reason)
    ? reason
    : "Channel delivery failed";
}

function isInvalidChannelFailure(
  result: Extract<SendResult, { ok: false }>,
  reason: string,
): boolean {
  if (result.channelInvalid !== undefined) {
    return result.channelInvalid;
  }

  // Older connector implementations encoded this provider-neutral signal in
  // their sanitized HTTP failure reason. Keep accepting that result shape.
  return /\bHTTP (?:401|403|404)\b/.test(reason);
}

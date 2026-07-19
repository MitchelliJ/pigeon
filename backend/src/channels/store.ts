/*
 * Channel persistence helpers.
 *
 * Keeps SQL mapping for provider-neutral channel delivery settings close to the
 * channels module while returning API-friendly camelCase objects.
 */
import type { Channel, ChannelKind, DeliveryMode } from "@pigeon/shared";

import type { Db } from "../db/index";

export async function getChannel(
  db: Db,
  userId: string,
): Promise<Channel | null> {
  const rows = await db.query`
    SELECT id, kind, status, last_error, created_at, updated_at
    FROM channels
    WHERE user_id = ${userId}
    LIMIT 1
  `;

  const row = rows[0];
  return row === undefined ? null : mapChannel(row);
}

export function mapChannel(row: Record<string, unknown>): Channel {
  return {
    id: String(row.id),
    kind: row.kind as ChannelKind,
    status: row.status as Channel["status"],
    lastError: row.last_error === null ? null : String(row.last_error),
    createdAt: toDate(row.created_at).toISOString(),
    updatedAt: toDate(row.updated_at).toISOString(),
  };
}

export interface DeliverySettings {
  userId: string;
  mode: DeliveryMode;
  digestTime: string;
  digestDays: number[];
  timezone: "UTC";
  deliveryBaselineAt: Date;
  lastDigestCutoffAt: Date | null;
}

export async function getDeliverySettings(
  db: Db,
  userId: string,
): Promise<DeliverySettings> {
  await db.query`
    INSERT INTO delivery_settings(user_id, delivery_baseline_at)
    VALUES (${userId}, now())
    ON CONFLICT (user_id) DO NOTHING
  `;

  const rows = await db.query`
    SELECT
      user_id,
      mode,
      digest_time,
      digest_days,
      delivery_baseline_at,
      last_digest_cutoff_at
    FROM delivery_settings
    WHERE user_id = ${userId}
  `;

  const row = rows[0];
  if (row === undefined) {
    throw new Error("delivery settings were not created");
  }

  return mapDeliverySettings(row);
}

export async function resetExistingDeliveryBaseline(
  db: Db,
  userId: string,
): Promise<void> {
  await db.query`
    UPDATE delivery_settings
    SET
      delivery_baseline_at = now(),
      last_digest_cutoff_at = NULL,
      updated_at = now()
    WHERE user_id = ${userId}
  `;
}

export async function resetDeliveryBaseline(
  db: Db,
  userId: string,
): Promise<void> {
  await db.query`
    INSERT INTO delivery_settings(
      user_id,
      delivery_baseline_at,
      last_digest_cutoff_at,
      updated_at
    )
    VALUES (${userId}, now(), NULL, now())
    ON CONFLICT (user_id) DO UPDATE SET
      delivery_baseline_at = excluded.delivery_baseline_at,
      last_digest_cutoff_at = NULL,
      updated_at = excluded.updated_at
  `;
}

function mapDeliverySettings(row: Record<string, unknown>): DeliverySettings {
  return {
    userId: String(row.user_id),
    mode: row.mode as DeliveryMode,
    digestTime: formatDigestTime(row.digest_time),
    digestDays: Array.isArray(row.digest_days)
      ? row.digest_days.map((day) => Number(day))
      : [],
    timezone: "UTC",
    deliveryBaselineAt: toDate(row.delivery_baseline_at),
    lastDigestCutoffAt:
      row.last_digest_cutoff_at === null
        ? null
        : toDate(row.last_digest_cutoff_at),
  };
}

function formatDigestTime(value: unknown): string {
  if (typeof value === "string") {
    return value.slice(0, 5);
  }

  return String(value).slice(0, 5);
}

function toDate(value: unknown): Date {
  return value instanceof Date ? value : new Date(String(value));
}

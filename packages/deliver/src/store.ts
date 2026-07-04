/** Channel + delivery-settings persistence. Channel config is vault-sealed. */
import type { Pool } from "@pigeon/db";
import type { Vault } from "@pigeon/vault";
import { getConnector } from "./connectors/index.js";
import type { ChannelKind, Priority } from "./types.js";

export interface Channel {
  id: string;
  userId: string;
  kind: ChannelKind;
  label: string;
  configSealed: string;
  minPriority: Priority;
  enabled: boolean;
}

export interface DeliverySettings {
  userId: string;
  digestEnabled: boolean;
  digestTime: string;
  digestDays: string[];
  digestChannelId: string | null;
  timezone: string;
  quietReassurance: boolean;
  lastDigestAt: Date | null;
}

function rowToChannel(row: Record<string, unknown>): Channel {
  return {
    id: row.id as string,
    userId: row.user_id as string,
    kind: row.kind as ChannelKind,
    label: row.label as string,
    configSealed: row.config_sealed as string,
    minPriority: row.min_priority as Priority,
    enabled: row.enabled as boolean,
  };
}

function rowToSettings(row: Record<string, unknown>): DeliverySettings {
  return {
    userId: row.user_id as string,
    digestEnabled: row.digest_enabled as boolean,
    digestTime: row.digest_time as string,
    digestDays: row.digest_days as string[],
    digestChannelId: (row.digest_channel_id as string) ?? null,
    timezone: row.timezone as string,
    quietReassurance: row.quiet_reassurance as boolean,
    lastDigestAt: (row.last_digest_at as Date) ?? null,
  };
}

const CHANNEL_COLS = "id, user_id, kind, label, config_sealed, min_priority, enabled";

export async function createChannel(
  pool: Pool,
  vault: Vault,
  input: {
    userId: string;
    kind: ChannelKind;
    label: string;
    config: Record<string, unknown>;
    minPriority: Priority;
  },
): Promise<Channel> {
  getConnector(input.kind).validateConfig(input.config);
  const { rows } = await pool.query(
    `INSERT INTO channels (user_id, kind, label, config_sealed, min_priority)
     VALUES ($1,$2,$3,$4,$5) RETURNING ${CHANNEL_COLS}`,
    [input.userId, input.kind, input.label, vault.seal(JSON.stringify(input.config)), input.minPriority],
  );
  return rowToChannel(rows[0]);
}

export async function listChannels(pool: Pool, userId: string): Promise<Channel[]> {
  const { rows } = await pool.query(
    `SELECT ${CHANNEL_COLS} FROM channels WHERE user_id = $1 ORDER BY created_at`,
    [userId],
  );
  return rows.map(rowToChannel);
}

export async function getChannel(pool: Pool, userId: string, id: string): Promise<Channel | null> {
  const { rows } = await pool.query(
    `SELECT ${CHANNEL_COLS} FROM channels WHERE id = $1 AND user_id = $2`,
    [id, userId],
  );
  return rows.length > 0 ? rowToChannel(rows[0]) : null;
}

export async function updateChannel(
  pool: Pool,
  vault: Vault,
  userId: string,
  id: string,
  patch: {
    label?: string;
    minPriority?: Priority;
    enabled?: boolean;
    config?: Record<string, unknown>;
  },
): Promise<Channel | null> {
  const existing = await getChannel(pool, userId, id);
  if (!existing) return null;
  if (patch.config) getConnector(existing.kind).validateConfig(patch.config);
  const { rows } = await pool.query(
    `UPDATE channels SET
       label = COALESCE($3, label),
       min_priority = COALESCE($4, min_priority),
       enabled = COALESCE($5, enabled),
       config_sealed = COALESCE($6, config_sealed),
       updated_at = now()
     WHERE id = $1 AND user_id = $2
     RETURNING ${CHANNEL_COLS}`,
    [
      id,
      userId,
      patch.label ?? null,
      patch.minPriority ?? null,
      patch.enabled ?? null,
      patch.config ? vault.seal(JSON.stringify(patch.config)) : null,
    ],
  );
  return rows.length > 0 ? rowToChannel(rows[0]) : null;
}

export async function deleteChannel(pool: Pool, userId: string, id: string): Promise<boolean> {
  const result = await pool.query(
    "DELETE FROM channels WHERE id = $1 AND user_id = $2",
    [id, userId],
  );
  return (result.rowCount ?? 0) > 0;
}

export function openChannelConfig(vault: Vault, channel: Channel): Record<string, unknown> {
  return JSON.parse(vault.open(channel.configSealed)) as Record<string, unknown>;
}

/** Settings row is created lazily with defaults on first read. */
export async function getDeliverySettings(pool: Pool, userId: string): Promise<DeliverySettings> {
  const { rows } = await pool.query(
    `INSERT INTO delivery_settings (user_id) VALUES ($1)
     ON CONFLICT (user_id) DO UPDATE SET user_id = EXCLUDED.user_id
     RETURNING *`,
    [userId],
  );
  return rowToSettings(rows[0]);
}

export async function updateDeliverySettings(
  pool: Pool,
  userId: string,
  patch: Partial<Omit<DeliverySettings, "userId" | "lastDigestAt">>,
): Promise<DeliverySettings> {
  await getDeliverySettings(pool, userId); // ensure row
  const { rows } = await pool.query(
    `UPDATE delivery_settings SET
       digest_enabled = COALESCE($2, digest_enabled),
       digest_time = COALESCE($3, digest_time),
       digest_days = COALESCE($4, digest_days),
       digest_channel_id = COALESCE($5, digest_channel_id),
       timezone = COALESCE($6, timezone),
       quiet_reassurance = COALESCE($7, quiet_reassurance),
       updated_at = now()
     WHERE user_id = $1
     RETURNING *`,
    [
      userId,
      patch.digestEnabled ?? null,
      patch.digestTime ?? null,
      patch.digestDays ?? null,
      patch.digestChannelId ?? null,
      patch.timezone ?? null,
      patch.quietReassurance ?? null,
    ],
  );
  return rowToSettings(rows[0]);
}

/** All users whose digest might be due (final due-check happens in JS). */
export async function listDigestCandidates(pool: Pool): Promise<DeliverySettings[]> {
  const { rows } = await pool.query(
    `SELECT * FROM delivery_settings
     WHERE digest_enabled = true AND digest_channel_id IS NOT NULL`,
  );
  return rows.map(rowToSettings);
}

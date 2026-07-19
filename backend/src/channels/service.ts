/*
 * Channel connection service.
 *
 * Owns the safe lifecycle around channel secrets: validate and test before
 * persisting, seal connector config at rest, and only return redacted channel
 * metadata to callers.
 */
import type { Channel, ChannelKind, DeliveryMode } from "@pigeon/shared";

import type { Db } from "../db/index";
import {
  getDeliverySettings,
  mapChannel,
  resetDeliveryBaseline,
  resetExistingDeliveryBaseline,
} from "./store";
import type { DeliverySettings } from "./store";

interface ChannelRegistryLike {
  get(kind: string): unknown;
}

interface ConnectorLike {
  validateConfig(input: unknown): unknown;
  sendTest(config: unknown): Promise<{ ok: boolean }>;
}

interface VaultLike {
  seal(plaintext: string): string | Promise<string>;
  open(sealed: string): string | Promise<string>;
}

type ChannelErrorCode =
  | "channel_exists"
  | "invalid_channel_config"
  | "channel_test_failed"
  | "channel_not_found"
  | "invalid_delivery_settings";

export interface DeliverySettingsPatch {
  mode?: string;
  digestTime?: string;
  digestDays?: number[];
}

export class ChannelServiceError extends Error {
  readonly code: ChannelErrorCode;

  constructor(code: ChannelErrorCode) {
    super(code);
    this.code = code;
  }
}

export async function connectChannel(
  db: Db,
  userId: string,
  kind: ChannelKind,
  configInput: unknown,
  registry: ChannelRegistryLike,
  vault: VaultLike,
): Promise<Channel> {
  const existing = await db.query`
    SELECT id FROM channels WHERE user_id = ${userId} LIMIT 1
  `;
  if (existing.length > 0) {
    throw channelError("channel_exists");
  }

  const connector = getConnector(registry, kind);
  const config = validateConfig(connector, configInput);
  const testResult = await connector.sendTest(config);
  if (!testResult.ok) {
    throw channelError("channel_test_failed");
  }

  const configEncrypted = await vault.seal(JSON.stringify(config));
  let rows: Array<Record<string, unknown>>;
  try {
    rows = await db.query`
      INSERT INTO channels(
        user_id,
        kind,
        config_encrypted,
        status,
        last_error,
        last_tested_at
      )
      VALUES (${userId}, ${kind}, ${configEncrypted}, 'active', NULL, now())
      RETURNING id, kind, status, last_error, created_at, updated_at
    `;
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw channelError("channel_exists");
    }
    throw error;
  }

  const row = rows[0];
  if (row === undefined) {
    throw new Error("channel was not created");
  }

  await resetExistingDeliveryBaseline(db, userId);

  return mapChannel(row);
}

export async function updateDeliverySettings(
  db: Db,
  userId: string,
  patch: DeliverySettingsPatch,
): Promise<DeliverySettings> {
  validateDeliverySettingsPatch(patch);

  await db.withTx(async (tx) => {
    await tx`
      INSERT INTO delivery_settings(user_id, delivery_baseline_at)
      VALUES (${userId}, now())
      ON CONFLICT (user_id) DO NOTHING
    `;

    const rows = await tx`
      SELECT mode
      FROM delivery_settings
      WHERE user_id = ${userId}
      FOR UPDATE
    `;
    const current = rows[0];
    if (current === undefined) {
      throw new Error("delivery settings were not created");
    }

    const modeChanged =
      patch.mode !== undefined && patch.mode !== String(current.mode);
    const mode = patch.mode ?? null;
    const digestTime = patch.digestTime ?? null;
    const digestDays = patch.digestDays ?? null;

    await tx`
      UPDATE delivery_settings
      SET
        mode = COALESCE(${mode}::TEXT, mode),
        digest_time = COALESCE(${digestTime}::TIME, digest_time),
        digest_days = COALESCE(${digestDays}::SMALLINT[], digest_days),
        delivery_baseline_at = CASE
          WHEN ${modeChanged} THEN now()
          ELSE delivery_baseline_at
        END,
        last_digest_cutoff_at = CASE
          WHEN ${modeChanged} THEN NULL
          ELSE last_digest_cutoff_at
        END,
        updated_at = now()
      WHERE user_id = ${userId}
    `;

    if (modeChanged) {
      await tx`
        UPDATE delivery_attempts
        SET
          status = 'failed',
          last_error = 'Delivery mode changed',
          updated_at = now()
        WHERE user_id = ${userId} AND status = 'pending'
      `;
    }
  });

  return getDeliverySettings(db, userId);
}

export async function disconnectChannel(
  db: Db,
  userId: string,
  channelId: string,
): Promise<void> {
  const rows = await db.query`
    DELETE FROM channels
    WHERE id = ${channelId} AND user_id = ${userId}
    RETURNING id
  `;

  if (rows.length === 0) {
    throw channelError("channel_not_found");
  }

  await resetDeliveryBaseline(db, userId);
}

export async function testChannel(
  db: Db,
  userId: string,
  channelId: string,
  registry: ChannelRegistryLike,
  vault: VaultLike,
): Promise<Channel> {
  const rows = await db.query`
    SELECT id, kind, config_encrypted
    FROM channels
    WHERE id = ${channelId} AND user_id = ${userId}
    LIMIT 1
  `;
  const channel = rows[0];

  if (channel === undefined) {
    throw channelError("channel_not_found");
  }

  const kind = String(channel.kind);
  const connector = getConnector(registry, kind);

  const plaintext = await vault.open(String(channel.config_encrypted));
  const config = JSON.parse(plaintext) as unknown;
  const testResult = await connector.sendTest(config);

  if (!testResult.ok) {
    throw channelError("channel_test_failed");
  }

  const updatedRows = await db.query`
    UPDATE channels
    SET
      status = 'active',
      last_error = NULL,
      last_tested_at = now(),
      updated_at = now()
    WHERE id = ${channelId} AND user_id = ${userId}
    RETURNING id, kind, status, last_error, created_at, updated_at
  `;
  const updated = updatedRows[0];
  if (updated === undefined) {
    throw channelError("channel_not_found");
  }

  return mapChannel(updated);
}

function validateDeliverySettingsPatch(patch: DeliverySettingsPatch): void {
  if (
    (patch.mode !== undefined && !isDeliveryMode(patch.mode)) ||
    (patch.digestTime !== undefined &&
      (typeof patch.digestTime !== "string" ||
        !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(patch.digestTime))) ||
    (patch.digestDays !== undefined && !areDigestDaysValid(patch.digestDays))
  ) {
    throw channelError("invalid_delivery_settings");
  }
}

function isDeliveryMode(value: unknown): value is DeliveryMode {
  return value === "daily" || value === "quiet";
}

function areDigestDaysValid(days: unknown): days is number[] {
  return (
    Array.isArray(days) &&
    days.length > 0 &&
    days.every(
      (day) =>
        typeof day === "number" &&
        Number.isInteger(day) &&
        day >= 1 &&
        day <= 7,
    ) &&
    new Set(days).size === days.length
  );
}

function getConnector(
  registry: ChannelRegistryLike,
  kind: string,
): ConnectorLike {
  const connector = registry.get(kind);
  if (!isConnectorLike(connector)) {
    throw channelError("invalid_channel_config");
  }

  return connector;
}

function validateConfig(connector: ConnectorLike, input: unknown): unknown {
  try {
    return connector.validateConfig(input);
  } catch {
    throw channelError("invalid_channel_config");
  }
}

function isConnectorLike(connector: unknown): connector is ConnectorLike {
  return (
    typeof connector === "object" &&
    connector !== null &&
    typeof (connector as { validateConfig?: unknown }).validateConfig ===
      "function" &&
    typeof (connector as { sendTest?: unknown }).sendTest === "function"
  );
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "23505"
  );
}

function channelError(code: ChannelErrorCode): ChannelServiceError {
  return new ChannelServiceError(code);
}

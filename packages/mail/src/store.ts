/** Mailbox + email persistence. Credentials are always vault-sealed. */
import type { Pool, PoolClient } from "@pigeon/db";
import type { Vault } from "@pigeon/vault";
import type { IncomingMessage, MailConnection, SyncState } from "./types.js";

export interface Mailbox {
  id: string;
  userId: string;
  provider: string;
  protocol: string;
  label: string;
  address: string;
  host: string;
  port: number;
  tls: boolean;
  username: string;
  credentialsSealed: string;
  status: "connected" | "syncing" | "error" | "disconnected";
  statusDetail: string | null;
  syncState: SyncState;
  lastSyncedAt: Date | null;
}

function rowToMailbox(row: Record<string, unknown>): Mailbox {
  return {
    id: row.id as string,
    userId: row.user_id as string,
    provider: row.provider as string,
    protocol: row.protocol as string,
    label: row.label as string,
    address: row.address as string,
    host: row.host as string,
    port: row.port as number,
    tls: row.tls as boolean,
    username: row.username as string,
    credentialsSealed: row.credentials_sealed as string,
    status: row.status as Mailbox["status"],
    statusDetail: (row.status_detail as string) ?? null,
    syncState: (row.sync_state as SyncState) ?? {},
    lastSyncedAt: (row.last_synced_at as Date) ?? null,
  };
}

const MAILBOX_COLS =
  "id, user_id, provider, protocol, label, address, host, port, tls, username, credentials_sealed, status, status_detail, sync_state, last_synced_at";

export interface NewMailbox {
  userId: string;
  provider: string;
  protocol: string;
  label: string;
  address: string;
  host: string;
  port: number;
  tls: boolean;
  username: string;
  /** Plaintext app password — sealed before it touches the database. */
  secret: string;
}

export async function createMailbox(
  pool: Pool,
  vault: Vault,
  input: NewMailbox,
): Promise<Mailbox> {
  const sealed = vault.seal(input.secret);
  const { rows } = await pool.query(
    `INSERT INTO mailboxes
       (user_id, provider, protocol, label, address, host, port, tls, username, credentials_sealed)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING ${MAILBOX_COLS}`,
    [
      input.userId,
      input.provider,
      input.protocol,
      input.label,
      input.address,
      input.host,
      input.port,
      input.tls,
      input.username,
      sealed,
    ],
  );
  return rowToMailbox(rows[0]);
}

export async function getMailbox(pool: Pool, id: string): Promise<Mailbox | null> {
  const { rows } = await pool.query(
    `SELECT ${MAILBOX_COLS} FROM mailboxes WHERE id = $1`,
    [id],
  );
  return rows.length > 0 ? rowToMailbox(rows[0]) : null;
}

export async function listMailboxes(pool: Pool, userId: string): Promise<Mailbox[]> {
  const { rows } = await pool.query(
    `SELECT ${MAILBOX_COLS} FROM mailboxes WHERE user_id = $1 ORDER BY created_at`,
    [userId],
  );
  return rows.map(rowToMailbox);
}

export async function deleteMailbox(pool: Pool, userId: string, id: string): Promise<boolean> {
  const result = await pool.query(
    "DELETE FROM mailboxes WHERE id = $1 AND user_id = $2",
    [id, userId],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Mailboxes due for a sync. `intervalForTier` maps the owner's tier to a
 * sync cadence ("quotas at the edge": frequency is a tier limit); pass a
 * constant function for a flat cadence.
 */
export async function listDueMailboxes(
  pool: Pool,
  intervalForTier: (tier: string) => number,
): Promise<Array<{ id: string; userId: string; tier: string; intervalMs: number }>> {
  const { rows } = await pool.query(
    `SELECT m.id, m.user_id, m.last_synced_at, u.tier
     FROM mailboxes m JOIN users u ON u.id = m.user_id
     WHERE m.status != 'disconnected'`,
  );
  const now = Date.now();
  return rows
    .map((r) => ({
      id: r.id as string,
      userId: r.user_id as string,
      tier: r.tier as string,
      lastSyncedAt: (r.last_synced_at as Date) ?? null,
      intervalMs: intervalForTier(r.tier as string),
    }))
    .filter((m) => m.lastSyncedAt === null || now - m.lastSyncedAt.getTime() >= m.intervalMs)
    .map(({ id, userId, tier, intervalMs }) => ({ id, userId, tier, intervalMs }));
}

export function mailboxConnection(vault: Vault, mailbox: Mailbox): MailConnection {
  return {
    host: mailbox.host,
    port: mailbox.port,
    tls: mailbox.tls,
    username: mailbox.username,
    secret: vault.open(mailbox.credentialsSealed),
    address: mailbox.address,
  };
}

export async function setMailboxStatus(
  db: Pool | PoolClient,
  id: string,
  status: Mailbox["status"],
  detail: string | null = null,
): Promise<void> {
  await db.query(
    `UPDATE mailboxes SET status = $2, status_detail = $3, updated_at = now() WHERE id = $1`,
    [id, status, detail],
  );
}

/**
 * Persist fetched messages and advance the watermark in ONE transaction —
 * an email is never at/below the stored watermark without being in the
 * database ("watermark before spend" inverted: persist before advance).
 * Returns ids of genuinely new rows (dedupe suppressed re-imports).
 */
export async function storeFetchResult(
  client: PoolClient,
  mailbox: Pick<Mailbox, "id" | "userId">,
  messages: IncomingMessage[],
  newState: SyncState,
  /** Already-sealed rotated credentials (OAuth refresh), when applicable. */
  resealedCredentials?: string,
): Promise<string[]> {
  const insertedIds: string[] = [];
  for (const msg of messages) {
    const { rows } = await client.query(
      `INSERT INTO emails
         (mailbox_id, user_id, dedupe_key, from_name, from_address, subject, body_text, received_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (mailbox_id, dedupe_key) DO NOTHING
       RETURNING id`,
      [
        mailbox.id,
        mailbox.userId,
        msg.dedupeKey,
        msg.fromName,
        msg.fromAddress,
        msg.subject,
        msg.bodyText,
        msg.receivedAt,
      ],
    );
    if (rows.length > 0) insertedIds.push(rows[0].id as string);
  }
  await client.query(
    `UPDATE mailboxes SET
       sync_state = $2,
       credentials_sealed = COALESCE($3, credentials_sealed),
       last_synced_at = now(),
       status = 'connected',
       status_detail = NULL,
       updated_at = now()
     WHERE id = $1`,
    [mailbox.id, JSON.stringify(newState), resealedCredentials ?? null],
  );
  return insertedIds;
}

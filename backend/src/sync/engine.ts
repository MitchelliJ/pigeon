/*
 * Incremental sync engine (Incremental Sync Engine & Watermarks PRD §3.3,
 * FR-6..FR-8). `syncMailbox` is the one entry point a job (or a manual
 * "sync now" trigger) calls to pull new messages for a single mailbox: it
 * loads the mailbox's connection details, asks the mailbox's
 * `MailboxConnector` for the current server-side id list (capped to the last
 * 7 days on a mailbox's very first sync, since `last_synced_at` is the
 * watermark that tells us whether this is a first sync at all), diffs that
 * list against what's already stored in `emails`, fetches only the genuinely
 * new ids, and inserts them.
 *
 * Dedup is enforced by the `emails (mailbox_id, provider_uid)` unique
 * constraint (0005_emails.sql) via `ON CONFLICT DO NOTHING` — the diff
 * against existing ids is an optimization to avoid re-fetching content we
 * already have, not the sole correctness mechanism, so a raced/duplicate
 * `providerUid` making it through to the INSERT is still handled safely
 * (FR-7).
 *
 * A connector-level failure (bad credentials, dropped connection, …) never
 * throws out of this function — it's reported back as `{ ok: false, reason }`
 * and the mailbox is marked `status = 'error'`, leaving `last_synced_at`
 * untouched so the next attempt still knows how far back to look.
 */
import type { Db } from "../db/index";
import type { Vault } from "../vault/index";
import type {
  MailboxConnector,
  TestConnectionParams,
} from "../mailboxes/connectors/types";

/** How far back a mailbox's very first sync reaches (FR-8). */
const FIRST_SYNC_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

export type SyncResult =
  { ok: true; inserted: number } | { ok: false; reason: string };

/** The subset of a `mailboxes` row `syncMailbox` needs to drive a connector. */
interface MailboxRow {
  host: string;
  port: number;
  tls: boolean;
  username: string;
  password_ciphertext: string;
  last_synced_at: Date | null;
}

/** Mark `mailboxId` as failed without disturbing its `last_synced_at`. */
async function markError(db: Db, mailboxId: string): Promise<void> {
  await db.query`
    UPDATE mailboxes SET status = 'error' WHERE id = ${mailboxId}`;
}

/**
 * Sync one mailbox: fetch new messages from its connector and store them.
 * See the module comment for the overall flow and its FR references.
 */
export async function syncMailbox(
  db: Db,
  vault: Vault,
  connector: MailboxConnector,
  mailboxId: string,
  connectTimeoutMs?: number,
): Promise<SyncResult> {
  const rows = await db.query`
    SELECT host, port, tls, username, password_ciphertext, last_synced_at
    FROM mailboxes WHERE id = ${mailboxId}`;
  const row = rows[0] as MailboxRow | undefined;
  if (!row) {
    return { ok: false, reason: "mailbox not found" };
  }

  const params: TestConnectionParams = {
    host: row.host,
    port: row.port,
    tls: row.tls,
    username: row.username,
    password: vault.open(row.password_ciphertext),
    // Honor the operator-configured MAILBOX_CONNECT_TIMEOUT_MS on the
    // background-sync path (threaded down from the worker); without this the
    // IMAP connector applies no explicit timeout at all and a hung server
    // stalls the job until imapflow's own internal defaults fire.
    ...(connectTimeoutMs !== undefined ? { connectTimeoutMs } : {}),
  };

  await db.query`
    UPDATE mailboxes SET status = 'syncing' WHERE id = ${mailboxId}`;

  const isFirstSync = row.last_synced_at === null;
  const since = isFirstSync
    ? new Date(Date.now() - FIRST_SYNC_LOOKBACK_MS)
    : undefined;

  const listResult = isFirstSync
    ? await connector.listMessageIds(params, { since })
    : await connector.listMessageIds(params);
  if (!listResult.ok) {
    await markError(db, mailboxId);
    return { ok: false, reason: listResult.reason };
  }

  const existingRows = await db.query`
    SELECT provider_uid FROM emails WHERE mailbox_id = ${mailboxId}`;
  const existingIds = new Set(existingRows.map((r) => String(r.provider_uid)));
  const newIds = listResult.ids.filter((id) => !existingIds.has(id));

  let insertedCount = 0;
  if (newIds.length > 0) {
    const fetchResult = isFirstSync
      ? await connector.fetchMessages(params, newIds, { since })
      : await connector.fetchMessages(params, newIds);
    if (!fetchResult.ok) {
      await markError(db, mailboxId);
      return { ok: false, reason: fetchResult.reason };
    }

    for (const message of fetchResult.messages) {
      const inserted = await db.query`
        INSERT INTO emails (
          mailbox_id, provider_uid, seen, from_name, from_address,
          subject, body, received_at
        ) VALUES (
          ${mailboxId}, ${message.providerUid}, ${message.seen},
          ${message.fromName}, ${message.fromAddress}, ${message.subject},
          ${message.body}, ${message.receivedAt}
        )
        ON CONFLICT (mailbox_id, provider_uid) DO NOTHING
        RETURNING id`;
      insertedCount += inserted.length;
    }
  }

  await db.query`
    UPDATE mailboxes SET status = 'connected', last_synced_at = now()
    WHERE id = ${mailboxId}`;

  return { ok: true, inserted: insertedCount };
}

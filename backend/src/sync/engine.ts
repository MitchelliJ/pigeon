/*
 * Incremental sync engine (Incremental Sync Engine & Watermarks PRD §3.3,
 * FR-6..FR-8). `syncMailbox` is the one entry point a job (or a manual
 * "sync now" trigger) calls to pull new messages for a single mailbox: it
 * loads the mailbox's connection details, asks the mailbox's
 * `MailboxConnector` for the current server-side id list, diffs that list
 * against what's already stored in `emails`, fetches only the genuinely new
 * ids, and inserts them.
 *
 * Canonical-timestamp invariant (PRD FR-1): `emails.received_at` — the parsed
 * `Date:` RFC822 header — is the single email timestamp Pigeon reasons about.
 * It drives selection, sort, classify-enqueue, and digest ranking. The engine
 * computes one cutoff per sync run and applies it post-parse authoritatively;
 * the `opts.since` value forwarded to connectors is an advisory coarse
 * pre-filter only (e.g. IMAP's `SEARCH SINCE`) and never the final word.
 *
 * Cutoff policy: a mailbox's very first sync (`last_synced_at IS NULL`) starts
 * the cutoff 7 days ago so the initial backfill window is bounded; every
 * subsequent incremental sync starts the cutoff at `last_synced_at`. Because
 * it is an inclusive `>=` comparison, re-runs safely re-pick up messages that
 * arrived within the same watermark tick.
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
 * and the mailbox is marked `status = 'error'`. On a mailbox's first sync
 * attempt, `last_synced_at` is also set so the historical window does not
 * retry forever; later failures leave the existing watermark unchanged.
 */
import type { Db } from "../db/index";
import { messageIdentityKey } from "../messages/identity";
import type { Vault } from "../vault/index";
import type {
  FetchedMessage,
  MailboxConnector,
  TestConnectionParams,
} from "../mailboxes/connectors/types";

/** How far back a mailbox's very first sync reaches (FR-8). */
const FIRST_SYNC_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

export type SyncResult =
  { ok: true; inserted: number } | { ok: false; reason: string };

/** The subset of a `mailboxes` row `syncMailbox` needs to drive a connector. */
interface MailboxRow {
  user_id: string;
  host: string;
  port: number;
  tls: boolean;
  username: string;
  password_ciphertext: string;
  last_synced_at: Date | null;
}

/** Mark `mailboxId` as failed, locking the watermark on first attempt only. */
async function markError(
  db: Db,
  mailboxId: string,
  isFirstSyncAttempt: boolean,
): Promise<void> {
  if (isFirstSyncAttempt) {
    await db.query`
      UPDATE mailboxes SET status = 'error', last_synced_at = now()
      WHERE id = ${mailboxId}`;
    return;
  }

  await db.query`
    UPDATE mailboxes SET status = 'error' WHERE id = ${mailboxId}`;
}

interface SyncCutoffPolicy {
  /** Authoritative post-parse cutoff for the canonical `received_at` timestamp (PRD FR-1). */
  receivedAtCutoff: Date;
  /** Advisory coarse pre-filter forwarded to connectors; omitted for incremental syncs. */
  connectorSince?: Date;
}

/** First-sync cutoff: 7 days ago (bounded initial backfill window, FR-8). */
function getFirstSyncCutoff(): Date {
  return new Date(Date.now() - FIRST_SYNC_LOOKBACK_MS);
}

/**
 * One cutoff policy per sync run, per FR-1/FR-8:
 * - first sync  (`last_synced_at IS NULL`): cutoff = 7 days ago, forwarded to connectors as a backfill advisory.
 * - incremental (`last_synced_at` set):       cutoff = `last_synced_at`, not forwarded — connectors return the full id
 *   list and the engine filters post-parse authoritatively.
 */
function getSyncCutoffPolicy(lastSyncedAt: Date | null): SyncCutoffPolicy {
  if (lastSyncedAt === null) {
    const firstSyncCutoff = getFirstSyncCutoff();
    return {
      receivedAtCutoff: firstSyncCutoff,
      connectorSince: firstSyncCutoff,
    };
  }

  return { receivedAtCutoff: lastSyncedAt };
}

/** Authoritative post-parse filter against the canonical `received_at` (PRD FR-1). */
function isMessageAfterCutoff(message: FetchedMessage, cutoff: Date): boolean {
  return message.receivedAt.getTime() >= cutoff.getTime();
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
    SELECT user_id, host, port, tls, username, password_ciphertext, last_synced_at
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

  const isFirstSyncAttempt = row.last_synced_at === null;
  const cutoffPolicy = getSyncCutoffPolicy(row.last_synced_at);

  const listResult = cutoffPolicy.connectorSince
    ? await connector.listMessageIds(params, {
        since: cutoffPolicy.connectorSince,
      })
    : await connector.listMessageIds(params);
  if (!listResult.ok) {
    await markError(db, mailboxId, isFirstSyncAttempt);
    return { ok: false, reason: listResult.reason };
  }

  const existingRows = await db.query`
    SELECT provider_uid FROM mailbox_messages WHERE mailbox_id = ${mailboxId}`;
  const existingIds = new Set(existingRows.map((r) => String(r.provider_uid)));
  const newIds = listResult.ids.filter((id) => !existingIds.has(id));

  let insertedCount = 0;
  if (newIds.length > 0) {
    const fetchResult = cutoffPolicy.connectorSince
      ? await connector.fetchMessages(params, newIds, {
          since: cutoffPolicy.connectorSince,
        })
      : await connector.fetchMessages(params, newIds);
    if (!fetchResult.ok) {
      await markError(db, mailboxId, isFirstSyncAttempt);
      return { ok: false, reason: fetchResult.reason };
    }

    const messages = fetchResult.messages.filter((message) =>
      isMessageAfterCutoff(message, cutoffPolicy.receivedAtCutoff),
    );

    for (const message of messages) {
      const identityKey = messageIdentityKey(message);
      const inserted = await db.withTx(async (tx) => {
        await tx`
          INSERT INTO messages (
            user_id, identity_key, from_name, from_address, subject, body,
            received_at
          ) VALUES (
            ${row.user_id}, ${identityKey}, ${message.fromName},
            ${message.fromAddress}, ${message.subject}, ${message.body},
            ${message.receivedAt}
          )
          ON CONFLICT (user_id, identity_key) DO NOTHING`;
        const canonical = await tx`
          SELECT id FROM messages
          WHERE user_id = ${row.user_id} AND identity_key = ${identityKey}`;
        const messageId = canonical[0]?.id;
        if (messageId === undefined) {
          throw new Error("canonical message resolution failed");
        }
        return tx`
          INSERT INTO mailbox_messages (
            mailbox_id, message_id, provider_uid, seen
          ) VALUES (
            ${mailboxId}, ${messageId}, ${message.providerUid}, ${message.seen}
          )
          ON CONFLICT DO NOTHING
          RETURNING id`;
      });
      insertedCount += inserted.length;
    }
  }

  await db.query`
    UPDATE mailboxes SET status = 'connected', last_synced_at = now()
    WHERE id = ${mailboxId}`;

  return { ok: true, inserted: insertedCount };
}

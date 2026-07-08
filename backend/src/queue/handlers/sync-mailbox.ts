/*
 * Sync-mailbox job handler (Job Queue, Workers & Scheduler PRD §3.2, FR-6).
 * `handleSyncMailboxJob` is the worker-side entry point a "sync this mailbox"
 * job dispatches to: it looks up which connector the mailbox uses, then
 * delegates everything else (loading the mailbox row, opening the
 * vault-sealed credential, marking `status`, inserting new messages) to the
 * real `syncMailbox` (Incremental Sync Engine PRD, `../../sync/engine`).
 *
 * `syncMailbox` never throws — it reports connector-level failures as
 * `{ ok: false, reason }` instead. The queue's job-dispatch contract expects
 * a rejected promise on failure (so it can route to `failJob`), so this
 * handler is the thin translation layer between the two: throw `reason` on
 * `{ ok: false }`, resolve on `{ ok: true }`.
 */
import type { Db } from "../../db/index";
import type { Vault } from "../../vault/index";
import type { MailboxConnector } from "../../mailboxes/connectors/types";
import { getConnector } from "../../mailboxes/connectors/index";
import { syncMailbox } from "../../sync/engine";

export async function handleSyncMailboxJob(
  db: Db,
  vault: Vault,
  payload: { mailboxId: string },
  getConnectorFn: (
    protocol: "imap" | "pop3",
  ) => MailboxConnector = getConnector,
  connectTimeoutMs?: number,
): Promise<void> {
  const rows = await db.query`
    SELECT protocol FROM mailboxes WHERE id = ${payload.mailboxId}`;
  const row = rows[0] as { protocol: "imap" | "pop3" } | undefined;
  if (!row) {
    // A job whose payload references a mailbox that no longer exists is a
    // programming/data error, not a connector-level sync failure — throw
    // directly instead of going through syncMailbox's { ok: false } path.
    throw new Error("mailbox not found");
  }

  const connector = getConnectorFn(row.protocol);
  const result = await syncMailbox(
    db,
    vault,
    connector,
    payload.mailboxId,
    connectTimeoutMs,
  );
  if (!result.ok) {
    throw new Error(result.reason);
  }
}

/**
 * Incremental sync engine. Runs inside a `mailbox.sync` job:
 * fetch new mail per the protocol watermark → persist + advance watermark +
 * enqueue triage jobs, all in one transaction. Idempotent: re-running after
 * a crash re-fetches at most one batch and dedupe suppresses duplicates.
 */
import type { Logger } from "@pigeon/config";
import { withTransaction, type Pool } from "@pigeon/db";
import { enqueue } from "@pigeon/queue";
import type { Vault } from "@pigeon/vault";
import { getProvider } from "./providers/index.js";
import {
  getMailbox,
  mailboxConnection,
  setMailboxStatus,
  storeFetchResult,
} from "./store.js";

export const JOB_MAILBOX_SYNC = "mailbox.sync";
export const JOB_EMAIL_PROCESS = "email.process";

export interface SyncOutcome {
  fetched: number;
  stored: number;
  hasMore: boolean;
}

export async function syncMailbox(
  pool: Pool,
  vault: Vault,
  logger: Logger,
  mailboxId: string,
  { limit = 50 }: { limit?: number } = {},
): Promise<SyncOutcome> {
  const mailbox = await getMailbox(pool, mailboxId);
  if (!mailbox || mailbox.status === "disconnected") {
    logger.info("sync skipped", { mailboxId, reason: "missing or disconnected" });
    return { fetched: 0, stored: 0, hasMore: false };
  }

  await setMailboxStatus(pool, mailbox.id, "syncing");
  try {
    const provider = getProvider(mailbox.protocol);
    const conn = mailboxConnection(vault, mailbox);
    const result = await provider.fetchNew(conn, mailbox.syncState, { limit });

    const insertedIds = await withTransaction(pool, async (client) => {
      const ids = await storeFetchResult(
        client,
        mailbox,
        result.messages,
        result.state,
        result.updatedSecret ? vault.seal(result.updatedSecret) : undefined,
      );
      // Triage jobs ride the same transaction: an email is enqueued exactly
      // once, if and only if its row committed.
      for (const emailId of ids) {
        await enqueue(client, JOB_EMAIL_PROCESS, { emailId }, { idempotencyKey: emailId });
      }
      // Big backlog: chain another sync immediately instead of waiting a tick.
      if (result.hasMore) {
        await enqueue(client, JOB_MAILBOX_SYNC, { mailboxId: mailbox.id }, {
          idempotencyKey: `${mailbox.id}:continue:${Date.now()}`,
        });
      }
      return ids;
    });

    logger.info("sync complete", {
      mailboxId: mailbox.id,
      fetched: result.messages.length,
      stored: insertedIds.length,
      hasMore: result.hasMore,
    });
    return {
      fetched: result.messages.length,
      stored: insertedIds.length,
      hasMore: result.hasMore,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await setMailboxStatus(pool, mailbox.id, "error", message).catch(() => {});
    throw err;
  }
}

/*
 * imapflow-based IMAP connector (PRD "Inbox Connectors & Provider
 * Abstraction" §3.2.2, FR-4/FR-5; extended by PRD "Incremental Sync Engine &
 * Watermarks" §3.2 FR-2). Unlike pop3.ts's hand-rolled socket code, IMAP goes
 * through the `imapflow` library — behind the small injectable `ImapClient`
 * interface (imap-client.ts) so this file's own logic (since-filtering, id
 * mapping, MIME parsing, error mapping) can be unit-tested against an
 * in-memory fake instead of a real socket or a real IMAP server.
 */

import { simpleParser } from "mailparser";
import { convert } from "html-to-text";
import type {
  FetchedMessage,
  FetchMessagesResult,
  ListMessageIdsResult,
  MailboxConnector,
  TestConnectionParams,
  TestConnectionResult,
} from "./types";
import {
  defaultImapFlowFactory,
  type ImapClient,
  type ImapClientFactory,
} from "./imap-client";

/** Matches `imapflow`'s `AuthenticationFailure` error shape without importing its class. */
function isAuthenticationFailure(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { authenticationFailed?: unknown }).authenticationFailed === true
  );
}

/** Same wording as shared.ts's `testTlsConnection` uses for the hand-rolled POP3 connector. */
function unreachableReason(params: TestConnectionParams): string {
  return `could not reach ${params.host}:${params.port}`;
}

/** Best-effort cleanup: never let a `close()` failure mask the real result. */
function safeClose(client: ImapClient): void {
  try {
    client.close();
  } catch {
    // Ignored — cleanup only, the connection is being discarded either way.
  }
}

/**
 * Parses one raw IMAP-fetched message with `mailparser`, mirroring pop3.ts's
 * `parseFetchedMessage`. Falls back to `html-to-text`'s plain-text conversion
 * when the message has no `text/plain` part. `seen` reflects IMAP's `\Seen`
 * flag (unlike POP3, which has no such flag and always reports `false`).
 */
async function parseFetchedImapMessage(item: {
  uid: number;
  source?: Buffer;
  flags?: Set<string>;
}): Promise<FetchedMessage> {
  const parsed = await simpleParser(item.source ?? Buffer.alloc(0));
  const from = parsed.from?.value[0];
  const body =
    parsed.text && parsed.text.length > 0
      ? parsed.text
      : convert(parsed.html || "");

  return {
    providerUid: String(item.uid),
    fromName: from?.name ?? "",
    fromAddress: from?.address ?? "",
    subject: parsed.subject ?? "",
    body,
    receivedAt: parsed.date ?? new Date(0),
    seen: item.flags?.has("\\Seen") ?? false,
  };
}

/**
 * Builds an IMAP `MailboxConnector`. Takes an `ImapClientFactory` so tests can
 * substitute an in-memory fake for the real `imapflow` connection
 * (`defaultImapFlowFactory`, used everywhere outside tests).
 */
export function createImapConnector(
  clientFactory: ImapClientFactory = defaultImapFlowFactory,
): MailboxConnector {
  return {
    async testConnection(params): Promise<TestConnectionResult> {
      const client = clientFactory(params);
      try {
        try {
          await client.connect();
        } catch (err) {
          return isAuthenticationFailure(err)
            ? { ok: false, reason: "authentication failed" }
            : { ok: false, reason: unreachableReason(params) };
        }

        try {
          await client.logout();
        } catch {
          // Best-effort: a logout failure doesn't mask a successful connect.
        }
        return { ok: true };
      } finally {
        safeClose(client);
      }
    },

    async listMessageIds(params, opts): Promise<ListMessageIdsResult> {
      const client = clientFactory(params);
      try {
        await client.connect();
        const lock = await client.getMailboxLock("INBOX");
        let uids: number[];
        try {
          uids = await client.search(
            opts?.since ? { since: opts.since } : { all: true },
            { uid: true },
          );
        } finally {
          lock.release();
        }
        try {
          await client.logout();
        } catch {
          // Best-effort: a logout failure doesn't mask a successful search.
        }
        return { ok: true, ids: uids.map(String) };
      } catch (err) {
        // Never throw out of a connector call — same convention as pop3.ts.
        return { ok: false, reason: String(err) };
      } finally {
        safeClose(client);
      }
    },

    async fetchMessages(params, ids, _opts): Promise<FetchMessagesResult> {
      // `_opts.since` is ignored here — IMAP's `SEARCH SINCE` at
      // `listMessageIds` time was only a coarse advisory pre-filter; the
      // sync engine applies the authoritative post-parse `receivedAt`
      // cutoff (engine.ts, PRD FR-1).
      const client = clientFactory(params);
      try {
        await client.connect();
        const lock = await client.getMailboxLock("INBOX");
        let messages: FetchedMessage[];
        try {
          messages = [];
          for await (const item of client.fetch(ids.map(Number), {
            uid: true,
            source: true,
            flags: true,
          })) {
            messages.push(await parseFetchedImapMessage(item));
          }
        } finally {
          lock.release();
        }
        try {
          await client.logout();
        } catch {
          // Best-effort: a logout failure doesn't mask a successful fetch.
        }
        return { ok: true, messages };
      } catch (err) {
        // Never throw out of a connector call — same convention as pop3.ts.
        return { ok: false, reason: String(err) };
      } finally {
        safeClose(client);
      }
    },
  };
}

export const imapConnector: MailboxConnector = createImapConnector();

/*
 * Injectable IMAP client interface (PRD "Incremental Sync Engine &
 * Watermarks" §3.2 FR-2). `imap.ts`'s own logic (since-filtering, id mapping,
 * MIME parsing, error mapping) is unit-tested against a small in-memory fake
 * implementing this interface, never a real socket — a purpose-built fake
 * IMAP server is deprecated/unmaintained, and the maintained alternative
 * needs a stateful MongoDB the project's single-box constraint rules out.
 * `defaultImapFlowFactory` below is the real, production implementation,
 * backed by the `imapflow` library.
 */

import { ImapFlow, type FetchQueryObject, type SearchObject } from "imapflow";
import type { TestConnectionParams } from "./types";

/**
 * Fallback timeout when a call doesn't thread one through
 * `TestConnectionParams` (e.g. the `POST /api/mailboxes` connection test).
 * Mirrors shared.ts's `DEFAULT_CONNECT_TIMEOUT_MS` so IMAP and POP3 behave the
 * same when no explicit timeout is supplied — see FR-5.
 */
const DEFAULT_CONNECT_TIMEOUT_MS = 10000;

/**
 * The narrow slice of an IMAP client `imap.ts` actually calls. `imapflow`'s
 * `ImapFlow` doesn't match this 1:1 (its real `fetch` takes a separate query
 * and options argument, and `search`/`fetch` can resolve `false`) — see
 * `defaultImapFlowFactory`, which adapts a real `ImapFlow` instance to this
 * shape — but the fake used in tests implements it directly.
 */
export interface ImapClient {
  connect(): Promise<void>;
  getMailboxLock(path: string): Promise<{ release(): void }>;
  search(
    query: Record<string, unknown>,
    options?: { uid?: boolean },
  ): Promise<number[]>;
  fetch(
    range: number[],
    options: Record<string, unknown>,
  ): AsyncIterable<{ uid: number; source?: Buffer; flags?: Set<string> }>;
  logout(): Promise<void>;
  close(): void;
}

/** Builds one `ImapClient` for a single `testConnection`/`listMessageIds`/`fetchMessages` call. */
export type ImapClientFactory = (params: TestConnectionParams) => ImapClient;

/**
 * The production factory: wraps a real `imapflow` connection so it matches
 * `ImapClient`. `logger: false` silences imapflow's own pino logging (imap.ts
 * logs connector-level problems itself where needed). `tls.ca` and the two
 * timeouts are test-only overrides threaded through from
 * `TestConnectionParams` (FR-19, §3.5) — mirrors shared.ts's identical
 * convention for the hand-rolled POP3 connector.
 *
 * `fetch` needs real translation, not just a cast: `imap.ts` calls
 * `client.fetch(range, { uid: true, ... })` with `uid` meaning "`range` holds
 * UIDs, not sequence numbers" (bundled into one options object per
 * `ImapClient`'s shape), whereas `ImapFlow.fetch(range, query, options)`
 * expects that addressing flag as a *separate* third argument. Without this
 * split, `range` would silently be treated as sequence numbers instead of
 * the UIDs `listMessageIds` handed back.
 *
 * The connect/socket timeouts are always applied — defaulting to
 * `DEFAULT_CONNECT_TIMEOUT_MS` when a call doesn't supply `connectTimeoutMs` —
 * so a hung IMAP server can never stall a sync indefinitely. imapflow's
 * `socketTimeout` is an *inactivity* timeout, so a long-but-progressing fetch
 * (e.g. a large first sync) is never aborted while data keeps flowing.
 */
export const defaultImapFlowFactory: ImapClientFactory = (params) => {
  const timeoutMs = params.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const client = new ImapFlow({
    host: params.host,
    port: params.port,
    secure: params.tls,
    auth: { user: params.username, pass: params.password },
    logger: false,
    ...(params.caCert ? { tls: { ca: params.caCert } } : {}),
    connectionTimeout: timeoutMs,
    socketTimeout: timeoutMs,
  });

  return {
    connect: () => client.connect(),
    getMailboxLock: (path) => client.getMailboxLock(path),
    async search(query, options) {
      // `ImapClient.search`'s `query` is intentionally a loosely-typed
      // `Record<string, unknown>` (so the test fake doesn't need imapflow's
      // types) — cast to imapflow's own `SearchObject` at this one real
      // boundary instead of loosening `ImapClient` itself.
      const result = await client.search(
        query as unknown as SearchObject,
        options,
      );
      // imapflow resolves `false` (rather than an empty array) when the
      // search itself couldn't be performed — an empty result is the
      // faithful `ImapClient` equivalent.
      return result === false ? [] : result;
    },
    async *fetch(range, options) {
      const { uid, ...query } = options;
      // Same cast rationale as `search` above, for imapflow's `FetchQueryObject`.
      for await (const item of client.fetch(
        range,
        query as unknown as FetchQueryObject,
        { uid: Boolean(uid) },
      )) {
        yield item;
      }
    },
    logout: () => client.logout(),
    close: () => client.close(),
  };
};

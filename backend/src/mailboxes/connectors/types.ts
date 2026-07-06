/*
 * Shared types for mailbox connectors (PRD "Inbox Connectors & Provider
 * Abstraction" §3.2.2, FR-4/FR-5). A `MailboxConnector` is the stable
 * interface `getConnector` returns for each supported protocol, so adding a
 * new provider (Feature 11's `gmail-oauth`/`microsoft-oauth`) is additive —
 * no caller of `getConnector` needs to change.
 */

/**
 * Parameters for `MailboxConnector.testConnection`.
 *
 * The public fields (`host`, `port`, `tls`, `username`, `password`) mirror
 * the `POST /api/mailboxes` request body (FR-6). `caCert` and
 * `connectTimeoutMs` are test-only overrides (FR-19, §3.5) — never sent by
 * the real route handler — that let integration tests trust a fixture's
 * self-signed certificate and use a short timeout, without weakening the
 * production TLS/timeout behavior for real users.
 */
export type TestConnectionParams = {
  host: string;
  port: number;
  tls: boolean;
  username: string;
  password: string;
  /**
   * Test-only: an additional PEM-encoded CA certificate to trust, on top of
   * (or, depending on Node version, instead of — see imap.ts) the system
   * trust store. `rejectUnauthorized` is never disabled because of this.
   */
  caCert?: string;
  /**
   * Test-only: overrides the default connect+auth timeout
   * (`MAILBOX_CONNECT_TIMEOUT_MS`, passed in by the route layer) for a
   * single call, so timeout tests don't have to wait out the real default.
   */
  connectTimeoutMs?: number;
};

export type TestConnectionResult = { ok: true } | { ok: false; reason: string };

/**
 * One MIME-parsed message as returned by `MailboxConnector.fetchMessages`
 * (PRD "Incremental Sync Engine & Watermarks" §3.2 FR-1). `providerUid` is
 * the protocol-native stable id (IMAP UID or POP3 UIDL) the sync engine
 * stores as `emails.provider_uid`; `seen` reflects the provider's read/unread
 * flag where one exists (POP3 has none, so it's always `false`, FR-9).
 */
export type FetchedMessage = {
  providerUid: string;
  fromName: string;
  fromAddress: string;
  subject: string;
  body: string;
  receivedAt: Date;
  seen: boolean;
};

export type ListMessageIdsResult =
  { ok: true; ids: string[] } | { ok: false; reason: string };

export type FetchMessagesResult =
  { ok: true; messages: FetchedMessage[] } | { ok: false; reason: string };

/** Stable interface every inbox provider connector implements. */
export interface MailboxConnector {
  testConnection(params: TestConnectionParams): Promise<TestConnectionResult>;
  /**
   * Every `provider_uid` currently in the mailbox. `opts.since` (first-sync
   * history cap only, FR-8) lets IMAP filter server-side; POP3 has no
   * server-side date filter and ignores it here (filtering happens in
   * `fetchMessages` instead).
   */
  listMessageIds(
    params: TestConnectionParams,
    opts?: { since?: Date },
  ): Promise<ListMessageIdsResult>;
  /**
   * Fetches and MIME-parses full content for exactly the requested
   * `providerUid`s (never re-fetches ids the caller already has stored —
   * that filtering happens in the sync engine). `opts.since` mirrors
   * `listMessageIds`'s option and drives POP3's `TOP`-then-`RETR`
   * peek-and-filter (FR-8); IMAP ignores it here since it already scoped the
   * id list via `SEARCH SINCE` at `listMessageIds` time.
   */
  fetchMessages(
    params: TestConnectionParams,
    ids: string[],
    opts?: { since?: Date },
  ): Promise<FetchMessagesResult>;
}

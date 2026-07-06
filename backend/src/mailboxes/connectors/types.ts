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

/** Stable interface every inbox provider connector implements. */
export interface MailboxConnector {
  testConnection(params: TestConnectionParams): Promise<TestConnectionResult>;
}

/** Provider-agnostic inbox abstraction (spec feature 4). */

export interface MailConnection {
  host: string;
  port: number;
  tls: boolean;
  username: string;
  /** Password or app password (OAuth access tokens slot in here later). */
  secret: string;
  /** The mailbox's email address (used by mock + display). */
  address: string;
}

/** A normalized new message, ready for persistence and triage. */
export interface IncomingMessage {
  /** RFC822 Message-ID when present, else a stable content hash. */
  dedupeKey: string;
  fromName: string;
  fromAddress: string;
  subject: string;
  /** Plain text body, already truncated at ingest. */
  bodyText: string;
  receivedAt: Date;
}

/** Protocol-specific watermark state, stored as jsonb on the mailbox. */
export type SyncState = Record<string, unknown>;

export interface FetchResult {
  messages: IncomingMessage[];
  /** New watermark — persist ONLY after `messages` are safely stored. */
  state: SyncState;
  /** True when a capped fetch left more new mail on the server. */
  hasMore: boolean;
  /**
   * Set when the provider rotated the credentials mid-fetch (OAuth token
   * refresh). The sync engine reseals and persists it with the watermark.
   */
  updatedSecret?: string;
}

export interface FetchOptions {
  /** Max messages per fetch (keeps jobs short and retryable). */
  limit?: number;
}

export interface InboxProvider {
  readonly protocol: string;
  /** Throws (with a human-readable message) when the connection fails. */
  testConnection(conn: MailConnection): Promise<void>;
  /** Fetch messages the watermark hasn't seen yet. */
  fetchNew(
    conn: MailConnection,
    state: SyncState,
    options?: FetchOptions,
  ): Promise<FetchResult>;
}

/** How many historic messages to import when a mailbox is first connected. */
export const FIRST_SYNC_BACKFILL = 5;
/** Truncation cap for stored plain-text bodies (data minimization). */
export const BODY_TEXT_MAX_CHARS = 16_000;

export function truncateBody(text: string): string {
  return text.length > BODY_TEXT_MAX_CHARS
    ? text.slice(0, BODY_TEXT_MAX_CHARS) + "\n[… truncated]"
    : text;
}

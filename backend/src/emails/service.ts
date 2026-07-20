/*
 * Emails read service (LLM Processing — Summarize + Classify PRD §3.4,
 * FR-12/FR-13/FR-14).
 *
 * Once the worker has summarized and classified a mailbox's emails, the
 * frontend needs two reads to render the triage inbox:
 *
 * - `loadCategoryCounts` — the numbers behind the category stat cards
 *   (FR-13). It groups the caller's classified emails by `category`, and
 *   always returns every category key (defaulting to `0`) so the UI never has
 *   to guard against a missing bucket.
 * - `loadEmailPage` — one page of a single category's emails, newest first
 *   (FR-12/FR-14). Pagination is keyset-based on `(received_at, id)` rather
 *   than OFFSET, so a page stays stable even as new mail arrives at the top.
 *   The cursor is an opaque base64 blob (callers must treat it as a token,
 *   not parse it) carrying the last row's keyset position.
 *
 * Both reads join `emails` to `mailboxes` and scope to `mailboxes.user_id`, so
 * a caller can only ever see their own mail.
 */
import type { Db } from "../db/index";
import type { Category, Email } from "@pigeon/shared";

/**
 * Thrown by `loadEmailPage` when the `cursor` query param can't be decoded
 * into a valid keyset position (not base64, not JSON, wrong shape, or an
 * unparseable timestamp). The route layer maps it to a `400 invalid_cursor`
 * instead of letting a malformed cursor crash into a 500.
 */
export class InvalidCursorError extends Error {
  constructor() {
    super("invalid cursor");
    this.name = "InvalidCursorError";
  }
}

/** Every category starts at 0 so the returned map always has all three keys. */
const EMPTY_COUNTS: Record<Category, number> = {
  requires_action: 0,
  important: 0,
  noise: 0,
};

/**
 * Count the caller's classified emails per category. Unclassified rows
 * (`category IS NULL`) are excluded, and every category key is always present
 * — folded onto zeroed defaults so the UI never sees a missing bucket.
 */
export async function loadCategoryCounts(
  db: Db,
  userId: string,
): Promise<Record<Category, number>> {
  const rows = await db.query`
    SELECT m.category, COUNT(*) AS count
    FROM messages m
    WHERE m.user_id = ${userId} AND m.category IS NOT NULL
    GROUP BY m.category
  `;

  const counts: Record<Category, number> = { ...EMPTY_COUNTS };
  for (const row of rows) {
    counts[row.category as Category] = Number(row.count);
  }
  return counts;
}

/** The keyset position a cursor carries: the last row's received_at + id. */
interface CursorPosition {
  receivedAt: string;
  id: string;
}

/** Encode a keyset position into an opaque base64 cursor token. */
function encodeCursor(position: CursorPosition): string {
  return Buffer.from(JSON.stringify(position)).toString("base64");
}

/**
 * Decode an opaque base64 cursor token back into its keyset position. The
 * cursor is attacker-supplied (it rides in on the query string), so every
 * failure mode — bad base64, bad JSON, missing/typed-wrong fields, or a
 * `receivedAt` that isn't a real timestamp — becomes an `InvalidCursorError`
 * rather than a thrown `SyntaxError` or a downstream Postgres cast error.
 */
function decodeCursor(cursor: string): CursorPosition {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64").toString("utf8"));
  } catch {
    throw new InvalidCursorError();
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as CursorPosition).receivedAt !== "string" ||
    typeof (parsed as CursorPosition).id !== "string" ||
    Number.isNaN(Date.parse((parsed as CursorPosition).receivedAt))
  ) {
    throw new InvalidCursorError();
  }
  return parsed as CursorPosition;
}

/** Shape a raw `emails` row (joined to its mailbox) into the shared `Email`. */
function toEmail(row: Record<string, unknown>): Email {
  const category = row.category as Category;
  const accountIds = (row.account_ids as unknown[]).map(String);
  const accountId = accountIds[0];
  if (accountId === undefined) {
    throw new Error("message has no mailbox occurrence");
  }
  return {
    id: String(row.id),
    accountId,
    accountIds,
    fromName: String(row.from_name),
    fromAddress: String(row.from_address),
    subject: String(row.subject),
    summary: String(row.summary),
    body: String(row.body),
    category,
    receivedAt: (row.received_at as Date).toISOString(),
    needsAttention: category === "requires_action",
    suggestedAction: undefined,
  };
}

/**
 * Load one page of the caller's emails in a single category, newest
 * `received_at` first (ties broken by `id`). Keyset pagination on
 * `(received_at, id)`: fetch `limit + 1` rows to peek past the page boundary,
 * and only when that extra row exists is there a `nextCursor` built from the
 * last row actually returned. Off-by-one here would skip or duplicate the
 * boundary row across pages, so the extra-row peek is the single source of
 * truth for "is there more?".
 */
export async function loadEmailPage(
  db: Db,
  userId: string,
  category: Category,
  cursor: string | undefined,
  limit: number,
): Promise<{ emails: Email[]; nextCursor: string | null }> {
  const position = cursor !== undefined ? decodeCursor(cursor) : undefined;

  const rows = position
    ? await db.query`
        SELECT m.id, occurrences.account_ids, m.from_name, m.from_address,
               m.subject, m.summary, m.body, m.category, m.received_at
        FROM messages m
        CROSS JOIN LATERAL (
          SELECT array_agg(mm.mailbox_id ORDER BY mb.created_at, mb.id) AS account_ids
          FROM mailbox_messages mm
          JOIN mailboxes mb ON mb.id = mm.mailbox_id
          WHERE mm.message_id = m.id
        ) occurrences
        WHERE m.user_id = ${userId}
          AND m.category = ${category}
          AND (
            m.received_at < ${position.receivedAt}
            OR (m.received_at = ${position.receivedAt} AND m.id < ${position.id})
          )
        ORDER BY m.received_at DESC, m.id DESC
        LIMIT ${limit + 1}
      `
    : await db.query`
        SELECT m.id, occurrences.account_ids, m.from_name, m.from_address,
               m.subject, m.summary, m.body, m.category, m.received_at
        FROM messages m
        CROSS JOIN LATERAL (
          SELECT array_agg(mm.mailbox_id ORDER BY mb.created_at, mb.id) AS account_ids
          FROM mailbox_messages mm
          JOIN mailboxes mb ON mb.id = mm.mailbox_id
          WHERE mm.message_id = m.id
        ) occurrences
        WHERE m.user_id = ${userId}
          AND m.category = ${category}
        ORDER BY m.received_at DESC, m.id DESC
        LIMIT ${limit + 1}
      `;

  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const emails = pageRows.map(toEmail);

  const lastEmail = emails[emails.length - 1];
  const nextCursor =
    hasMore && lastEmail
      ? encodeCursor({ receivedAt: lastEmail.receivedAt, id: lastEmail.id })
      : null;

  return { emails, nextCursor };
}

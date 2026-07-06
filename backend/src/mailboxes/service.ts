/*
 * Mailbox connect/remove business logic (Inbox Connectors & Provider
 * Abstraction PRD §3.2.3/§3.2.4, FR-6..FR-9). No HTTP here — `./routes`
 * translates these result shapes into responses.
 *
 * `connectMailbox` runs the connector's `testConnection` BEFORE touching the
 * database (FR-6/FR-7: a mailbox is never persisted unless the credentials
 * actually work), then seals the password (never stored in plaintext — see
 * coding guidelines §2 "Secrets & config") and inserts the row. FR-8 requires
 * the connection test to run even when the `(user_id, address)` pair is
 * already connected, so duplicates aren't detected with an up-front SELECT —
 * they're caught as a `mailboxes_user_id_address_key` unique-violation
 * (Postgres code `23505`) from the INSERT itself, which is both simpler than
 * a separate SELECT-then-INSERT and race-free.
 */
import type { Db } from "../db/index";
import type { Vault } from "../vault/index";
import type { MailboxConnector } from "./connectors/types";
import { enqueueSyncJob } from "../queue/store";

/** Postgres SQLSTATE for a unique-constraint violation. */
const UNIQUE_VIOLATION_CODE = "23505";

/** `POST /api/mailboxes` request fields, already Zod-validated by `./routes`. */
export interface ConnectMailboxInput {
  provider: string;
  protocol: "imap" | "pop3";
  label: string;
  address: string;
  host: string;
  port: number;
  tls: true;
  username: string;
  password: string;
}

/** A freshly connected mailbox, shaped for the `POST /api/mailboxes` response. */
export interface ConnectedMailbox {
  id: string;
  provider: string;
  label: string;
  address: string;
  protocol: string;
  status: string;
}

export type ConnectMailboxResult =
  | { kind: "created"; mailbox: ConnectedMailbox }
  | { kind: "duplicate" }
  | { kind: "connection_failed"; reason: string };

/** Narrow an unknown thrown value down to "was this a 23505 from postgres.js?" */
function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === UNIQUE_VIOLATION_CODE
  );
}

/**
 * Connect a mailbox for `userId` (FR-6..FR-8). Tests the connection first;
 * on success, seals the password and inserts the row, translating a
 * `(user_id, address)` unique-violation into the `duplicate` result instead
 * of throwing.
 */
export async function connectMailbox(
  db: Db,
  vault: Vault,
  connector: MailboxConnector,
  userId: string,
  input: ConnectMailboxInput,
): Promise<ConnectMailboxResult> {
  const testResult = await connector.testConnection({
    host: input.host,
    port: input.port,
    tls: input.tls,
    username: input.username,
    password: input.password,
  });
  if (!testResult.ok) {
    return { kind: "connection_failed", reason: testResult.reason };
  }

  const passwordCiphertext = vault.seal(input.password);

  try {
    const rows = await db.query`
      INSERT INTO mailboxes (
        user_id, provider, protocol, label, address, host, port, tls,
        username, password_ciphertext, status
      )
      VALUES (
        ${userId}, ${input.provider}, ${input.protocol}, ${input.label},
        ${input.address}, ${input.host}, ${input.port}, ${input.tls},
        ${input.username}, ${passwordCiphertext}, 'connected'
      )
      RETURNING id, provider, label, address, protocol, status
    `;
    const row = rows[0];
    if (!row) {
      throw new Error("connectMailbox: insert returned no row");
    }

    await enqueueSyncJob(db, String(row.id));

    return {
      kind: "created",
      mailbox: {
        id: String(row.id),
        provider: String(row.provider),
        label: String(row.label),
        address: String(row.address),
        protocol: String(row.protocol),
        status: String(row.status),
      },
    };
  } catch (err) {
    if (isUniqueViolation(err)) {
      return { kind: "duplicate" };
    }
    throw err;
  }
}

/**
 * Remove `mailboxId`, scoped to `userId` (FR-9). Matching neither "doesn't
 * exist" nor "belongs to someone else" is distinguished from the other —
 * both come back as `removed: false`, which `./routes` maps to a 404 either
 * way, so ownership is never leaked to the caller.
 */
export async function removeMailbox(
  db: Db,
  userId: string,
  mailboxId: string,
): Promise<{ removed: boolean }> {
  const rows = await db.query`
    DELETE FROM mailboxes WHERE id = ${mailboxId} AND user_id = ${userId}
    RETURNING id
  `;
  return { removed: rows.length > 0 };
}

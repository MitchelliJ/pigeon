/** Auth domain logic: users, credentials, sessions. Hand-written SQL via the shared pool. */
import { createHash, randomBytes } from "node:crypto";
import type { Pool } from "@pigeon/db";
import { hashPassword, verifyPassword } from "./hash.js";

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  tier: string;
  createdAt: Date;
}

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days, sliding

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function rowToUser(row: {
  id: string;
  email: string;
  name: string;
  tier: string;
  created_at: Date;
}): AuthUser {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    tier: row.tier,
    createdAt: row.created_at,
  };
}

export class EmailTakenError extends Error {
  constructor() {
    super("an account with this email already exists");
    this.name = "EmailTakenError";
  }
}

export async function createUser(
  pool: Pool,
  input: { email: string; password: string; name?: string },
): Promise<AuthUser> {
  const passwordHash = await hashPassword(input.password);
  try {
    const { rows } = await pool.query(
      `INSERT INTO users (email, name, password_hash)
       VALUES ($1, $2, $3)
       RETURNING id, email, name, tier, created_at`,
      [input.email.trim(), input.name?.trim() ?? "", passwordHash],
    );
    return rowToUser(rows[0]);
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "23505") {
      throw new EmailTakenError();
    }
    throw err;
  }
}

/** Returns the user when email+password check out, else null. */
export async function verifyLogin(
  pool: Pool,
  email: string,
  password: string,
): Promise<AuthUser | null> {
  const { rows } = await pool.query(
    `SELECT id, email, name, tier, created_at, password_hash
     FROM users WHERE lower(email) = lower($1)`,
    [email.trim()],
  );
  if (rows.length === 0) {
    // Burn comparable time so missing accounts aren't distinguishable.
    await verifyPassword(password, "scrypt:16384:8:1:AAAAAAAAAAAAAAAAAAAAAA==:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=");
    return null;
  }
  const ok = await verifyPassword(password, rows[0].password_hash);
  return ok ? rowToUser(rows[0]) : null;
}

/** Creates a session; returns the raw token (only ever held by the client). */
export async function createSession(pool: Pool, userId: string): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await pool.query(
    `INSERT INTO sessions (token_hash, user_id, expires_at)
     VALUES ($1, $2, now() + $3::interval)`,
    [sha256(token), userId, `${SESSION_TTL_MS} milliseconds`],
  );
  return token;
}

/** Resolves a session token to its user; touches the sliding expiry. */
export async function getSessionUser(
  pool: Pool,
  token: string,
): Promise<AuthUser | null> {
  const { rows } = await pool.query(
    `UPDATE sessions s
     SET last_seen_at = now(), expires_at = now() + $2::interval
     FROM users u
     WHERE s.token_hash = $1 AND s.user_id = u.id AND s.expires_at > now()
     RETURNING u.id, u.email, u.name, u.tier, u.created_at`,
    [sha256(token), `${SESSION_TTL_MS} milliseconds`],
  );
  return rows.length > 0 ? rowToUser(rows[0]) : null;
}

export async function deleteSession(pool: Pool, token: string): Promise<void> {
  await pool.query("DELETE FROM sessions WHERE token_hash = $1", [sha256(token)]);
}

/** Periodic cleanup (called by the worker later). */
export async function deleteExpiredSessions(pool: Pool): Promise<number> {
  const result = await pool.query("DELETE FROM sessions WHERE expires_at <= now()");
  return result.rowCount ?? 0;
}

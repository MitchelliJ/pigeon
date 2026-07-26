/*
 * `oauth_states` repository (OAuth Provider Connectors PRD): short-lived
 * one-time PKCE code-verifier / CSRF state storage. `consumeOAuthState`
 * atomically deletes-and-returns the row so a state can only be redeemed
 * once, with expiry enforced directly in the `WHERE` clause.
 */
import type { Db } from "../db/index";

export async function insertOAuthState(
  db: Db,
  params: {
    state: string;
    userId: string;
    codeVerifier: string;
    expiresAt: Date;
  },
): Promise<void> {
  await db.query`
    INSERT INTO oauth_states (state, user_id, code_verifier, expires_at)
    VALUES (${params.state}, ${params.userId}, ${params.codeVerifier}, ${params.expiresAt})
  `;
}

export async function consumeOAuthState(
  db: Db,
  state: string,
): Promise<{ userId: string; codeVerifier: string } | null> {
  const rows = await db.query`
    DELETE FROM oauth_states
    WHERE state = ${state} AND expires_at > now()
    RETURNING user_id, code_verifier
  `;
  const row = rows[0];
  if (!row) return null;
  return {
    userId: String(row.user_id),
    codeVerifier: String(row.code_verifier),
  };
}

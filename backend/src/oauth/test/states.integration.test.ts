/**
 * Integration tests for the `0015_oauth_connectors` migration (OAuth
 * Provider Connectors PRD): the `mailboxes_credential_by_protocol_check`
 * CHECK constraint that makes password- and OAuth-based credentials
 * mutually exclusive per protocol.
 *
 * Mirrors the setup pattern used by `./routes.integration.test.ts`:
 * `withTestDb()`, `runMigrations`, inserting a `users` row directly via
 * `db.query`.
 */
import { describe, it, expect } from "vitest";
import { withTestDb } from "../../../test/db";
import { runMigrations } from "../../migrate/runner";
import type { Db } from "../../db/index";
import { insertOAuthState, consumeOAuthState } from "../states";

async function createUser(db: Db, email: string): Promise<string> {
  const rows = await db.query`
    INSERT INTO users(email, name, password_hash)
    VALUES (${email}, 'Test User', 'not-a-real-hash')
    RETURNING id
  `;
  return String(rows[0]?.id);
}

describe("0015 oauth_connectors migration", () => {
  it("inserts an imap mailbox with a password ciphertext and no oauth refresh ciphertext", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const userId = await createUser(db, "imap-user@example.com");

      const rows = await db.query`
        INSERT INTO mailboxes(
          user_id, provider, protocol, label, address, host, port, tls,
          username, password_ciphertext
        )
        VALUES (
          ${userId}, 'imap', 'imap', 'Personal', 'imap-user@example.com',
          'imap.example.com', 993, true, 'imap-user@example.com',
          'sealed-password-ciphertext'
        )
        RETURNING provider, protocol, password_ciphertext, oauth_refresh_ciphertext
      `;

      expect(rows[0]?.provider).toBe("imap");
      expect(rows[0]?.protocol).toBe("imap");
      expect(rows[0]?.password_ciphertext).toBe("sealed-password-ciphertext");
      expect(rows[0]?.oauth_refresh_ciphertext).toBeNull();
    } finally {
      await close();
    }
  });

  it("rejects a microsoft-oauth mailbox that carries a password ciphertext instead of an oauth refresh ciphertext", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const userId = await createUser(db, "bad-oauth-user@example.com");

      await expect(db.query`
        INSERT INTO mailboxes(
          user_id, provider, protocol, label, address, host, port, tls,
          username, password_ciphertext
        )
        VALUES (
          ${userId}, 'outlook', 'microsoft-oauth', 'Work', 'bad-oauth-user@example.com',
          'outlook.office365.com', 993, true, 'bad-oauth-user@example.com',
          'sealed-password-ciphertext'
        )
      `).rejects.toThrow(
        /mailboxes_credential_by_protocol_check|check constraint/i,
      );
    } finally {
      await close();
    }
  });

  it("inserts a well-formed microsoft-oauth mailbox with an oauth refresh ciphertext and no password ciphertext", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const userId = await createUser(db, "good-oauth-user@example.com");

      const rows = await db.query`
        INSERT INTO mailboxes(
          user_id, provider, protocol, label, address, host, port, tls,
          username, oauth_refresh_ciphertext
        )
        VALUES (
          ${userId}, 'outlook', 'microsoft-oauth', 'Work', 'good-oauth-user@example.com',
          'outlook.office365.com', 993, true, 'good-oauth-user@example.com',
          'sealed-refresh-ciphertext'
        )
        RETURNING provider, protocol, password_ciphertext, oauth_refresh_ciphertext
      `;

      expect(rows[0]?.provider).toBe("outlook");
      expect(rows[0]?.protocol).toBe("microsoft-oauth");
      expect(rows[0]?.password_ciphertext).toBeNull();
      expect(rows[0]?.oauth_refresh_ciphertext).toBe(
        "sealed-refresh-ciphertext",
      );
    } finally {
      await close();
    }
  });
});

describe("oauth_states repository", () => {
  it("insert then consume returns the row and deletes it (one-time)", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const userId = await createUser(db, "oauth-states-user-1@example.com");
      const state = crypto.randomUUID();
      const codeVerifier = "test-code-verifier-1";
      const expiresAt = new Date(Date.now() + 10 * 60_000);

      await insertOAuthState(db, { state, userId, codeVerifier, expiresAt });

      const result = await consumeOAuthState(db, state);
      expect(result).toEqual({ userId, codeVerifier });

      const secondResult = await consumeOAuthState(db, state);
      expect(secondResult).toBeNull();
    } finally {
      await close();
    }
  });

  it("consume of an expired state returns null", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const userId = await createUser(db, "oauth-states-user-2@example.com");
      const state = crypto.randomUUID();
      const codeVerifier = "test-code-verifier-2";
      const expiresAt = new Date(Date.now() - 60_000);

      await insertOAuthState(db, { state, userId, codeVerifier, expiresAt });

      const result = await consumeOAuthState(db, state);
      expect(result).toBeNull();
    } finally {
      await close();
    }
  });

  it("distinguishes states belonging to different users", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const userIdA = await createUser(db, "oauth-states-user-3a@example.com");
      const userIdB = await createUser(db, "oauth-states-user-3b@example.com");
      const stateA = crypto.randomUUID();
      const stateB = crypto.randomUUID();
      const expiresAt = new Date(Date.now() + 10 * 60_000);

      await insertOAuthState(db, {
        state: stateA,
        userId: userIdA,
        codeVerifier: "verifier-a",
        expiresAt,
      });
      await insertOAuthState(db, {
        state: stateB,
        userId: userIdB,
        codeVerifier: "verifier-b",
        expiresAt,
      });

      const resultA = await consumeOAuthState(db, stateA);
      const resultB = await consumeOAuthState(db, stateB);

      expect(resultA?.userId).toBe(userIdA);
      expect(resultB?.userId).toBe(userIdB);
    } finally {
      await close();
    }
  });
});

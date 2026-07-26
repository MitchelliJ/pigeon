/*
 * Integration test for `getAccessToken` (OAuth Provider Connectors PRD).
 *
 * Boots a real embedded Postgres per test via `withTestDb` + `runMigrations`,
 * seals a fake refresh token through a real `createVault(TEST_VAULT_KEY)`
 * (same fixed test key pattern as `../../sync/test/engine.integration.test.ts`),
 * inserts a `microsoft-oauth` mailbox carrying that sealed refresh token, and
 * drives `getAccessToken` against an injected fake `refresh` grant function —
 * no real Microsoft token endpoint here.
 *
 * RED note: at authoring time `../tokens` (`getAccessToken`) does not exist
 * yet — this file is expected to fail at import/module-resolution time, not
 * just at an assertion, until that module is implemented.
 */
import { describe, it, expect, vi } from "vitest";
import { withTestDb } from "../../../test/db";
import { runMigrations } from "../../migrate/runner";
import { createVault } from "../../vault/index";
import { getAccessToken } from "../tokens";
import type { Db } from "../../db/index";
import type { Vault } from "../../vault/index";

const TEST_VAULT_KEY = "J371VUEASEUQsYjxvMKhAklLcZOslC7QAGV9/NWQTbY=";

async function insertUser(db: Db, email: string): Promise<string> {
  const rows = await db.query`
    INSERT INTO users(email, name, password_hash)
    VALUES (${email}, ${"U"}, ${"h"})
    RETURNING id`;
  return String(rows[0]?.id);
}

/** Insert a `microsoft-oauth` mailbox carrying a vault-sealed refresh token. */
async function insertOAuthMailbox(
  db: Db,
  vault: Vault,
  userId: string,
  address: string,
): Promise<string> {
  const rows = await db.query`
    INSERT INTO mailboxes(
      user_id, provider, protocol, label, address, host, port, tls,
      username, oauth_refresh_ciphertext, oauth_scope
    ) VALUES (
      ${userId}, ${"outlook"}, ${"microsoft-oauth"}, ${"Outlook"}, ${address},
      ${"outlook.office365.com"}, ${993}, ${true}, ${address},
      ${vault.seal("rt-original")},
      ${"offline_access openid email https://outlook.office.com/IMAP.AccessAsUser.All"}
    ) RETURNING id`;
  return String(rows[0]?.id);
}

describe("getAccessToken", () => {
  it("unseals the stored refresh token, calls the refresh grant, and returns the fresh access token", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const vault = createVault(TEST_VAULT_KEY);
      const userId = await insertUser(db, "oauth-tokens@example.com");
      const mailboxId = await insertOAuthMailbox(
        db,
        vault,
        userId,
        "oauth-tokens@example.com",
      );

      const refresh = vi.fn(async (refreshToken: string) => {
        expect(refreshToken).toBe("rt-original");
        return {
          accessToken: "at-fresh",
          refreshToken: "rt-original",
          scope:
            "offline_access openid email https://outlook.office.com/IMAP.AccessAsUser.All",
          expiresIn: 3600,
        };
      });

      const accessToken = await getAccessToken(db, vault, mailboxId, refresh);

      expect(accessToken).toBe("at-fresh");
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(refresh).toHaveBeenCalledWith("rt-original");
    } finally {
      await close();
    }
  });

  it("re-seals and persists a rotated refresh token on the mailbox row", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const vault = createVault(TEST_VAULT_KEY);
      const userId = await insertUser(db, "oauth-tokens-rotate@example.com");
      const mailboxId = await insertOAuthMailbox(
        db,
        vault,
        userId,
        "oauth-tokens-rotate@example.com",
      );

      const refresh = async () => ({
        accessToken: "at-fresh",
        refreshToken: "rt-rotated",
        scope:
          "offline_access openid email https://outlook.office.com/IMAP.AccessAsUser.All",
        expiresIn: 3600,
      });

      await getAccessToken(db, vault, mailboxId, refresh);

      const rows = await db.query`
        SELECT oauth_refresh_ciphertext FROM mailboxes WHERE id = ${mailboxId}`;
      const storedRefreshToken = vault.open(
        String(rows[0]?.oauth_refresh_ciphertext),
      );

      expect(storedRefreshToken).toBe("rt-rotated");
    } finally {
      await close();
    }
  });

  it("surfaces a failed refresh grant as a rejection (no silent empty token)", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const vault = createVault(TEST_VAULT_KEY);
      const userId = await insertUser(db, "oauth-tokens-fail@example.com");
      const mailboxId = await insertOAuthMailbox(
        db,
        vault,
        userId,
        "oauth-tokens-fail@example.com",
      );

      const refresh = vi.fn(async () => {
        throw new Error("invalid_grant: refresh token revoked");
      });

      let resolvedAccessToken: string | undefined;
      await expect(
        getAccessToken(db, vault, mailboxId, refresh).then((token) => {
          resolvedAccessToken = token;
          return token;
        }),
      ).rejects.toThrow(/invalid_grant|revoked/);
      expect(resolvedAccessToken).toBeUndefined();
    } finally {
      await close();
    }
  });

  it("rejects rather than returning an empty access token when the refresh grant yields none", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const vault = createVault(TEST_VAULT_KEY);
      const userId = await insertUser(db, "oauth-tokens-empty@example.com");
      const mailboxId = await insertOAuthMailbox(
        db,
        vault,
        userId,
        "oauth-tokens-empty@example.com",
      );

      const refresh = vi.fn(async () => ({
        accessToken: "",
        refreshToken: "rt-original",
        scope:
          "offline_access openid email https://outlook.office.com/IMAP.AccessAsUser.All",
        expiresIn: 3600,
      }));

      await expect(
        getAccessToken(db, vault, mailboxId, refresh),
      ).rejects.toThrow();
    } finally {
      await close();
    }
  });
});

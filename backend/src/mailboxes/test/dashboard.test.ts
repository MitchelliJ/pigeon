/**
 * Integration tests for `GET /api/dashboard` (Inbox Connectors & Provider
 * Abstraction PRD §3.2.5, FR-10).
 *
 * RED note: at authoring time `../dashboard` (`dashboardRoutes`) does not
 * exist yet — this file is expected to fail at import/mount time (module not
 * found), not just at an assertion, until it is implemented.
 *
 * Mirrors the exact setup pattern used by `./routes.test.ts`: `withTestDb()`,
 * `runMigrations`, `createVault(TEST_VAULT_KEY)` (used only to seal a dummy
 * password so the `mailboxes.password_ciphertext` NOT NULL column is
 * satisfied — the dashboard route itself needs no vault/connector since it
 * only reads), inserting a `users` row directly, minting a session directly
 * via `generateToken()`/`hashToken()` into the `sessions` table, and driving
 * requests with `app.request(...)` plus a `pigeon_session=<token>` cookie.
 */
import { describe, it, expect } from "vitest";
import { TIERS } from "@pigeon/shared";
import { withTestDb } from "../../../test/db";
import { runMigrations } from "../../migrate/runner";
import { createVault } from "../../vault/index";
import { generateToken, hashToken } from "../../auth/tokens";
import { dashboardRoutes } from "../dashboard";
import type { Db } from "../../db/index";
import type { Vault } from "../../vault/index";

const TEST_VAULT_KEY = "J371VUEASEUQsYjxvMKhAklLcZOslC7QAGV9/NWQTbY=";

/** Insert a user row directly and mint a live session, returning its cookie token. */
async function createUserWithSession(
  db: Db,
  email: string,
  name: string,
): Promise<{ userId: string; token: string }> {
  const userRows = await db.query`
    INSERT INTO users(email, name, password_hash)
    VALUES (${email}, ${name}, 'not-a-real-hash')
    RETURNING id
  `;
  const userId = String(userRows[0]?.id);

  const token = generateToken();
  const tokenHash = hashToken(token);
  await db.query`
    INSERT INTO sessions(user_id, token_hash, expires_at)
    VALUES (${userId}, ${tokenHash}, now() + interval '1 day')
  `;

  return { userId, token };
}

/** Insert a mailbox row directly for `userId`, sealing a dummy password via `vault`. */
async function insertMailbox(
  db: Db,
  vault: Vault,
  userId: string,
  address: string,
  label: string,
): Promise<void> {
  await db.query`
    INSERT INTO mailboxes (
      user_id, provider, protocol, label, address, host, port, tls,
      username, password_ciphertext, status
    )
    VALUES (
      ${userId}, 'imap', 'imap', ${label}, ${address}, 'imap.example.com',
      993, true, ${address}, ${vault.seal("whatever")}, 'connected'
    )
  `;
}

describe("GET /api/dashboard", () => {
  it("assembles user/plan, real accounts, and placeholder fields for a free-tier user with two mailboxes", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const vault = createVault(TEST_VAULT_KEY);
      const { userId, token } = await createUserWithSession(
        db,
        "ivy@example.com",
        "Ivy Example",
      );
      await insertMailbox(db, vault, userId, "one@example.com", "One");
      await insertMailbox(db, vault, userId, "two@example.com", "Two");

      const app = dashboardRoutes(db);
      const res = await app.request("/api/dashboard", {
        headers: { cookie: `pigeon_session=${token}` },
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        user: {
          email: string;
          name: string;
          plan: {
            tier: string;
            inboxLimit: number | null;
            canUpgrade: boolean;
          };
        };
        accounts: Array<Record<string, unknown>>;
        stats: unknown;
        emails: unknown;
        channels: unknown;
        digest: { enabled: boolean };
        lastSync: string;
      };

      expect(body.user.email).toBe("ivy@example.com");
      expect(body.user.name).toBe("Ivy Example");
      expect(body.user.plan.tier).toBe("free");
      expect(body.user.plan.inboxLimit).toBe(TIERS.free.maxMailboxes);
      expect(body.user.plan.canUpgrade).toBe(true);

      expect(body.accounts).toHaveLength(2);
      for (const account of body.accounts) {
        expect(account.unread).toBe(0);
        expect(Object.keys(account)).not.toContain("password");
        expect(Object.keys(account)).not.toContain("password_ciphertext");
        expect(Object.keys(account)).not.toContain("username");
      }
      const addresses = body.accounts.map((a) => a.address);
      expect(addresses).toEqual(
        expect.arrayContaining(["one@example.com", "two@example.com"]),
      );

      expect(body.stats).toEqual({ urgent: 0, important: 0, everything: 0 });
      expect(body.emails).toEqual([]);
      expect(body.channels).toEqual([]);
      expect(body.digest.enabled).toBe(false);
      expect(body.lastSync).toBe("Never");
    } finally {
      await close();
    }
  });

  it("returns an empty accounts array (not an error) for a user with no connected mailboxes", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const { token } = await createUserWithSession(
        db,
        "jack@example.com",
        "Jack Example",
      );

      const app = dashboardRoutes(db);
      const res = await app.request("/api/dashboard", {
        headers: { cookie: `pigeon_session=${token}` },
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { accounts: unknown[] };
      expect(body.accounts).toEqual([]);
    } finally {
      await close();
    }
  });

  it("rejects a request with no session cookie: 401", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);

      const app = dashboardRoutes(db);
      const res = await app.request("/api/dashboard");

      expect(res.status).toBe(401);
    } finally {
      await close();
    }
  });
});

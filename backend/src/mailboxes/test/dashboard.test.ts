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
import { randomUUID } from "node:crypto";
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

/**
 * Insert a mailbox row directly for `userId`, sealing a dummy password via
 * `vault`. Returns the new mailbox's id (existing callers that ignore the
 * return value are unaffected).
 */
async function insertMailbox(
  db: Db,
  vault: Vault,
  userId: string,
  address: string,
  label: string,
): Promise<string> {
  const rows = await db.query`
    INSERT INTO mailboxes (
      user_id, provider, protocol, label, address, host, port, tls,
      username, password_ciphertext, status
    )
    VALUES (
      ${userId}, 'imap', 'imap', ${label}, ${address}, 'imap.example.com',
      993, true, ${address}, ${vault.seal("whatever")}, 'connected'
    )
    RETURNING id
  `;
  return String(rows[0]?.id);
}

/**
 * Insert a mailbox row directly for `userId` with an explicit `protocol`
 * (`insertMailbox` above hardcodes `protocol: 'imap'`, which the POP3 test
 * below needs to override).
 */
async function insertMailboxWithProtocol(
  db: Db,
  vault: Vault,
  userId: string,
  address: string,
  label: string,
  protocol: string,
): Promise<string> {
  const rows = await db.query`
    INSERT INTO mailboxes (
      user_id, provider, protocol, label, address, host, port, tls,
      username, password_ciphertext, status
    )
    VALUES (
      ${userId}, 'imap', ${protocol}, ${label}, ${address}, 'imap.example.com',
      993, true, ${address}, ${vault.seal("whatever")}, 'connected'
    )
    RETURNING id
  `;
  return String(rows[0]?.id);
}

/** Insert a minimal-but-valid `emails` row for `mailboxId`. */
async function insertEmail(
  db: Db,
  mailboxId: string,
  providerUid: string,
  seen: boolean,
): Promise<void> {
  await db.query`
    INSERT INTO emails (
      mailbox_id, provider_uid, seen, from_name, from_address, subject, body, received_at
    )
    VALUES (
      ${mailboxId}, ${providerUid}, ${seen}, 'A', 'a@example.com', 'S', 'B', now()
    )
  `;
}

/**
 * Insert a classified `emails` row for `mailboxId`. Mirrors `insertEmail`
 * above, but a classified row always carries `summary`, `category`, and
 * `classified_at` — the fields the dashboard's real `stats`/`emails` reads key
 * off. `provider_uid` is a fresh UUID so rows never collide within a mailbox.
 */
async function insertClassifiedEmail(
  db: Db,
  mailboxId: string,
  overrides: { category: string; receivedAt?: Date; subject?: string },
): Promise<void> {
  const { category, receivedAt = new Date(), subject = "S" } = overrides;
  await db.query`
    INSERT INTO emails (
      mailbox_id, provider_uid, seen, from_name, from_address, subject, body,
      received_at, summary, category, classified_at
    )
    VALUES (
      ${mailboxId}, ${randomUUID()}, false, 'A', 'a@example.com', ${subject},
      'B', ${receivedAt}, 'placeholder summary', ${category}, now()
    )
  `;
}

describe("GET /api/dashboard", () => {
  it("assembles user/plan, real accounts, and inert channel/digest placeholders (stats/emails are covered by a dedicated test)", async () => {
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

      // This user has no classified emails, so real grouped stats are all
      // zero (keyed by category) and there is no requires_action page to show.
      expect(body.stats).toEqual({
        requires_action: 0,
        important: 0,
        noise: 0,
      });
      expect(body.emails).toEqual([]);
      expect(body.channels).toEqual([]);
      expect(body.digest.enabled).toBe(false);
      expect(body.lastSync).toBe("Never");
    } finally {
      await close();
    }
  });

  it("reflects real grouped stats and the caller's first page (capped at 10) of requires_action emails, newest first, without leaking another user's mail", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const vault = createVault(TEST_VAULT_KEY);
      const { userId, token } = await createUserWithSession(
        db,
        "nia@example.com",
        "Nia Example",
      );
      const mailboxId = await insertMailbox(
        db,
        vault,
        userId,
        "nia-inbox@example.com",
        "Nia Inbox",
      );
      // 12 requires_action (more than one page), plus 1 important + 1 noise.
      // Distinct, increasing received_at so "ra-11" is unambiguously newest.
      for (let i = 0; i < 12; i++) {
        await insertClassifiedEmail(db, mailboxId, {
          category: "requires_action",
          subject: `ra-${i}`,
          receivedAt: new Date(2026, 0, i + 1),
        });
      }
      await insertClassifiedEmail(db, mailboxId, {
        category: "important",
        subject: "imp",
        receivedAt: new Date(2026, 1, 1),
      });
      await insertClassifiedEmail(db, mailboxId, {
        category: "noise",
        subject: "noise",
        receivedAt: new Date(2026, 1, 2),
      });

      // A second user with their own classified mail — none of it must appear
      // in nia's stats or emails.
      const otherId = (
        await createUserWithSession(db, "otto@example.com", "Otto Example")
      ).userId;
      const otherMailboxId = await insertMailbox(
        db,
        vault,
        otherId,
        "otto-inbox@example.com",
        "Otto Inbox",
      );
      for (let i = 0; i < 5; i++) {
        await insertClassifiedEmail(db, otherMailboxId, {
          category: "requires_action",
          subject: `otto-ra-${i}`,
          receivedAt: new Date(2026, 2, i + 1),
        });
      }

      const app = dashboardRoutes(db);
      const res = await app.request("/api/dashboard", {
        headers: { cookie: `pigeon_session=${token}` },
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        stats: { requires_action: number; important: number; noise: number };
        emails: Array<{
          accountId: string;
          category: string;
          needsAttention: boolean;
          subject: string;
          summary: string;
        }>;
      };

      // Real grouped counts, keyed by category and scoped to nia only.
      expect(body.stats).toEqual({
        requires_action: 12,
        important: 1,
        noise: 1,
      });

      // First page is capped at 10 requires_action emails, newest first.
      expect(body.emails).toHaveLength(10);
      expect(body.emails[0]?.subject).toBe("ra-11");
      expect(body.emails.map((e) => e.subject)).toEqual([
        "ra-11",
        "ra-10",
        "ra-9",
        "ra-8",
        "ra-7",
        "ra-6",
        "ra-5",
        "ra-4",
        "ra-3",
        "ra-2",
      ]);
      for (const email of body.emails) {
        expect(email.category).toBe("requires_action");
        expect(email.needsAttention).toBe(true);
        expect(email.summary).toBe("placeholder summary");
        expect(email.accountId).toBe(mailboxId);
      }
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

  it("reflects a live unseen-email count in accounts[].unread for an IMAP mailbox", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const vault = createVault(TEST_VAULT_KEY);
      const { userId, token } = await createUserWithSession(
        db,
        "kim@example.com",
        "Kim Example",
      );
      const mailboxId = await insertMailbox(
        db,
        vault,
        userId,
        "kim-inbox@example.com",
        "Kim Inbox",
      );
      await insertEmail(db, mailboxId, "uid-1", false);
      await insertEmail(db, mailboxId, "uid-2", false);
      await insertEmail(db, mailboxId, "uid-3", true);

      const app = dashboardRoutes(db);
      const res = await app.request("/api/dashboard", {
        headers: { cookie: `pigeon_session=${token}` },
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        accounts: Array<{ address: string; unread: number }>;
      };
      const account = body.accounts.find(
        (a) => a.address === "kim-inbox@example.com",
      );
      expect(account?.unread).toBe(2);
    } finally {
      await close();
    }
  });

  it("always reports 0 unread for a POP3-protocol mailbox, even with unseen rows", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const vault = createVault(TEST_VAULT_KEY);
      const { userId, token } = await createUserWithSession(
        db,
        "leo@example.com",
        "Leo Example",
      );
      const mailboxId = await insertMailboxWithProtocol(
        db,
        vault,
        userId,
        "leo-pop3@example.com",
        "Leo POP3",
        "pop3",
      );
      await insertEmail(db, mailboxId, "uid-1", false);
      await insertEmail(db, mailboxId, "uid-2", false);

      const app = dashboardRoutes(db);
      const res = await app.request("/api/dashboard", {
        headers: { cookie: `pigeon_session=${token}` },
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        accounts: Array<{ address: string; unread: number }>;
      };
      const account = body.accounts.find(
        (a) => a.address === "leo-pop3@example.com",
      );
      expect(account?.unread).toBe(0);
    } finally {
      await close();
    }
  });

  it("reflects the most recent mailboxes.last_synced_at as a relative-time string in lastSync", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const vault = createVault(TEST_VAULT_KEY);
      const { userId, token } = await createUserWithSession(
        db,
        "mona@example.com",
        "Mona Example",
      );
      const olderMailboxId = await insertMailbox(
        db,
        vault,
        userId,
        "mona-old@example.com",
        "Mona Old",
      );
      const recentMailboxId = await insertMailbox(
        db,
        vault,
        userId,
        "mona-recent@example.com",
        "Mona Recent",
      );
      await db.query`
        UPDATE mailboxes SET last_synced_at = now() - interval '2 hours'
        WHERE id = ${olderMailboxId}
      `;
      await db.query`
        UPDATE mailboxes SET last_synced_at = now() - interval '5 minutes'
        WHERE id = ${recentMailboxId}
      `;

      const app = dashboardRoutes(db);
      const res = await app.request("/api/dashboard", {
        headers: { cookie: `pigeon_session=${token}` },
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { lastSync: string };
      expect(body.lastSync).toMatch(/ago$/);
      expect(body.lastSync).not.toBe("Never");
    } finally {
      await close();
    }
  });
});

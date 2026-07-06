/**
 * Integration tests for `POST /api/mailboxes` and `DELETE /api/mailboxes/:id`
 * (Inbox Connectors & Provider Abstraction PRD §3.2.3/§3.2.4, FR-6..FR-9;
 * §3.5 FR-20).
 *
 * RED note: at authoring time neither `../routes` (`mailboxesRoutes`) nor
 * `../service` exist yet — this file is expected to fail at import/mount
 * time (module not found), not just at an assertion, until both are
 * implemented.
 *
 * Each test boots its own embedded Postgres cluster via `withTestDb`, runs
 * migrations, builds a `Vault` from the fixed committed test key (same key
 * used elsewhere in this repo, e.g. `backend/test/config.test.ts`), inserts a
 * user + session row directly (mirroring the auth schema, not the auth HTTP
 * surface, since this feature only needs an authenticated caller, not a full
 * signup/login flow), and mounts `mailboxesRoutes(db, vault, fakeConnectorFn)`
 * — the third, optional argument is a dependency-injection hook so tests can
 * hand in a fake `MailboxConnector` and never touch real network (FR-20).
 */
import { describe, it, expect } from "vitest";
import { withTestDb } from "../../../test/db";
import { runMigrations } from "../../migrate/runner";
import { createVault } from "../../vault/index";
import { generateToken, hashToken } from "../../auth/tokens";
import { mailboxesRoutes } from "../routes";
import type { Db } from "../../db/index";
import type {
  MailboxConnector,
  TestConnectionResult,
} from "../connectors/types";

const TEST_VAULT_KEY = "J371VUEASEUQsYjxvMKhAklLcZOslC7QAGV9/NWQTbY=";
const JSON_HEADERS = { "content-type": "application/json" };

/** Minimal shape of an error/status JSON response body, for `.json()` casts. */
type ErrorBody = { error?: string; code?: string };

/** Minimal shape of a successful `POST /api/mailboxes` response body. */
type MailboxBody = {
  mailbox: {
    id: string;
    provider: string;
    label: string;
    address: string;
    protocol: string;
    status: string;
    unread: number;
  };
};

/** Build a fake connector that always resolves `result`, never touching a socket. */
function fakeConnector(result: TestConnectionResult): MailboxConnector {
  return {
    testConnection: async () => result,
    listMessageIds: async () => ({
      ok: false,
      reason: "not used in this test",
    }),
    fetchMessages: async () => ({ ok: false, reason: "not used in this test" }),
  };
}

/** Valid `POST /api/mailboxes` request body used across the happy-path tests. */
function validMailboxBody(overrides: Record<string, unknown> = {}) {
  return {
    provider: "imap",
    protocol: "imap",
    label: "Test",
    address: "a@b.com",
    host: "imap.example.com",
    port: 993,
    tls: true,
    username: "a@b.com",
    password: "app-password-123",
    ...overrides,
  };
}

/** Insert a user row directly and mint a live session, returning its cookie token. */
async function createUserWithSession(
  db: Db,
  email: string,
): Promise<{ userId: string; token: string }> {
  const userRows = await db.query`
    INSERT INTO users(email, name, password_hash)
    VALUES (${email}, 'Test User', 'not-a-real-hash')
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

describe("POST /api/mailboxes and DELETE /api/mailboxes/:id", () => {
  it("connects a mailbox on a successful connection test: 201, correctly-shaped body, encrypted password persisted", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const vault = createVault(TEST_VAULT_KEY);
      const { userId, token } = await createUserWithSession(
        db,
        "ada@example.com",
      );
      const app = mailboxesRoutes(db, vault, () => fakeConnector({ ok: true }));

      const res = await app.request("/api/mailboxes", {
        method: "POST",
        headers: { ...JSON_HEADERS, cookie: `pigeon_session=${token}` },
        body: JSON.stringify(validMailboxBody()),
      });

      expect(res.status).toBe(201);
      const body = (await res.json()) as MailboxBody;
      expect(body.mailbox).toMatchObject({
        provider: "imap",
        label: "Test",
        address: "a@b.com",
        protocol: "imap",
        status: "connected",
        unread: 0,
      });
      expect(body.mailbox.id).toBeTruthy();
      expect(typeof body.mailbox.id).toBe("string");

      const rows = await db.query`
        SELECT password_ciphertext FROM mailboxes WHERE user_id = ${userId}
      `;
      expect(rows).toHaveLength(1);
      const ciphertext = String(rows[0]?.password_ciphertext);
      expect(ciphertext).not.toBe("app-password-123");
      expect(vault.open(ciphertext)).toBe("app-password-123");

      const jobRows = await db.query`
        SELECT status FROM jobs
        WHERE type = 'sync_mailbox' AND payload->>'mailboxId' = ${body.mailbox.id}
      `;
      expect(jobRows).toEqual([{ status: "pending" }]);
    } finally {
      await close();
    }
  });

  it("a failing connection test returns 422 connection_failed and persists no row", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const vault = createVault(TEST_VAULT_KEY);
      const { userId, token } = await createUserWithSession(
        db,
        "bea@example.com",
      );
      const app = mailboxesRoutes(db, vault, () =>
        fakeConnector({ ok: false, reason: "authentication failed" }),
      );

      const res = await app.request("/api/mailboxes", {
        method: "POST",
        headers: { ...JSON_HEADERS, cookie: `pigeon_session=${token}` },
        body: JSON.stringify(validMailboxBody()),
      });

      expect(res.status).toBe(422);
      const body = (await res.json()) as ErrorBody;
      expect(body).toMatchObject({
        error: "authentication failed",
        code: "connection_failed",
      });

      const countRows = await db.query`
        SELECT count(*)::int AS n FROM mailboxes WHERE user_id = ${userId}
      `;
      expect(countRows[0]?.n).toBe(0);
    } finally {
      await close();
    }
  });

  it("provider: mock is rejected with 400 provider_not_supported before any connection attempt", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const vault = createVault(TEST_VAULT_KEY);
      const { token } = await createUserWithSession(db, "carl@example.com");

      let called = false;
      const app = mailboxesRoutes(db, vault, () => ({
        testConnection: async () => {
          called = true;
          throw new Error("should not be called");
        },
        listMessageIds: async () => ({
          ok: false,
          reason: "not used in this test",
        }),
        fetchMessages: async () => ({
          ok: false,
          reason: "not used in this test",
        }),
      }));

      const res = await app.request("/api/mailboxes", {
        method: "POST",
        headers: { ...JSON_HEADERS, cookie: `pigeon_session=${token}` },
        body: JSON.stringify(validMailboxBody({ provider: "mock" })),
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as ErrorBody;
      expect(body.code).toBe("provider_not_supported");
      expect(called).toBe(false);
    } finally {
      await close();
    }
  });

  it("tls: false is rejected with 400 tls_required", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const vault = createVault(TEST_VAULT_KEY);
      const { token } = await createUserWithSession(db, "dee@example.com");
      const app = mailboxesRoutes(db, vault, () => fakeConnector({ ok: true }));

      const res = await app.request("/api/mailboxes", {
        method: "POST",
        headers: { ...JSON_HEADERS, cookie: `pigeon_session=${token}` },
        body: JSON.stringify(validMailboxBody({ tls: false })),
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as ErrorBody;
      expect(body.code).toBe("tls_required");
    } finally {
      await close();
    }
  });

  it("connecting the same (user, address) twice returns 409 mailbox_already_connected", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const vault = createVault(TEST_VAULT_KEY);
      const { token } = await createUserWithSession(db, "eve@example.com");
      const app = mailboxesRoutes(db, vault, () => fakeConnector({ ok: true }));

      const firstRes = await app.request("/api/mailboxes", {
        method: "POST",
        headers: { ...JSON_HEADERS, cookie: `pigeon_session=${token}` },
        body: JSON.stringify(validMailboxBody()),
      });
      expect(firstRes.status).toBe(201);

      const secondRes = await app.request("/api/mailboxes", {
        method: "POST",
        headers: { ...JSON_HEADERS, cookie: `pigeon_session=${token}` },
        body: JSON.stringify(validMailboxBody({ label: "Second Label" })),
      });

      expect(secondRes.status).toBe(409);
      const body = (await secondRes.json()) as ErrorBody;
      expect(body.code).toBe("mailbox_already_connected");
    } finally {
      await close();
    }
  });

  it("deletes the caller's own mailbox: 200 { ok: true }, row gone from the database", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const vault = createVault(TEST_VAULT_KEY);
      const { token } = await createUserWithSession(db, "flo@example.com");
      const app = mailboxesRoutes(db, vault, () => fakeConnector({ ok: true }));

      const createRes = await app.request("/api/mailboxes", {
        method: "POST",
        headers: { ...JSON_HEADERS, cookie: `pigeon_session=${token}` },
        body: JSON.stringify(validMailboxBody()),
      });
      expect(createRes.status).toBe(201);
      const created = (await createRes.json()) as MailboxBody;
      const mailboxId = created.mailbox.id;

      const deleteRes = await app.request(`/api/mailboxes/${mailboxId}`, {
        method: "DELETE",
        headers: { cookie: `pigeon_session=${token}` },
      });

      expect(deleteRes.status).toBe(200);
      const deleteBody = (await deleteRes.json()) as { ok?: boolean };
      expect(deleteBody.ok).toBe(true);

      const rows = await db.query`
        SELECT id FROM mailboxes WHERE id = ${mailboxId}
      `;
      expect(rows).toHaveLength(0);
    } finally {
      await close();
    }
  });

  it("deleting someone else's mailbox returns 404 and leaves the row untouched", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const vault = createVault(TEST_VAULT_KEY);
      const { token: tokenA } = await createUserWithSession(
        db,
        "gia@example.com",
      );
      const { token: tokenB } = await createUserWithSession(
        db,
        "hank@example.com",
      );
      const app = mailboxesRoutes(db, vault, () => fakeConnector({ ok: true }));

      const createRes = await app.request("/api/mailboxes", {
        method: "POST",
        headers: { ...JSON_HEADERS, cookie: `pigeon_session=${tokenA}` },
        body: JSON.stringify(validMailboxBody()),
      });
      expect(createRes.status).toBe(201);
      const created = (await createRes.json()) as MailboxBody;
      const mailboxId = created.mailbox.id;

      const deleteRes = await app.request(`/api/mailboxes/${mailboxId}`, {
        method: "DELETE",
        headers: { cookie: `pigeon_session=${tokenB}` },
      });

      expect(deleteRes.status).toBe(404);

      const rows = await db.query`
        SELECT id FROM mailboxes WHERE id = ${mailboxId}
      `;
      expect(rows).toHaveLength(1);
    } finally {
      await close();
    }
  });

  it("rejects both POST and DELETE with no session cookie: 401", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const vault = createVault(TEST_VAULT_KEY);
      const app = mailboxesRoutes(db, vault, () => fakeConnector({ ok: true }));

      const postRes = await app.request("/api/mailboxes", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify(validMailboxBody()),
      });
      expect(postRes.status).toBe(401);

      const deleteRes = await app.request(
        "/api/mailboxes/00000000-0000-0000-0000-000000000000",
        { method: "DELETE" },
      );
      expect(deleteRes.status).toBe(401);
    } finally {
      await close();
    }
  });
});

/**
 * Integration tests for `GET /api/oauth/providers` (Inbox Connectors &
 * Provider Abstraction PRD §3.2.6, FR-11).
 *
 * RED note: `oauthRoutes` currently only takes `db` and always returns
 * `{ providers: [] }`; this file exercises the new `oauthRoutes(db, config)`
 * signature and expects Microsoft discovery to depend on `config`, so it
 * fails to typecheck/pass until that lands.
 *
 * Mirrors the exact setup pattern used by
 * `../../mailboxes/test/dashboard.test.ts`: `withTestDb()`, `runMigrations`,
 * inserting a `users` row directly, minting a session directly via
 * `generateToken()`/`hashToken()` into the `sessions` table, and driving
 * requests with `app.request(...)` plus a `pigeon_session=<token>` cookie.
 */
import { describe, it, expect } from "vitest";
import { withTestDb } from "../../../test/db";
import { runMigrations } from "../../migrate/runner";
import { generateToken, hashToken } from "../../auth/tokens";
import { oauthRoutes } from "../routes";
import { MICROSOFT_SCOPE } from "../microsoft";
import type { TokenPoster } from "../microsoft";
import { computeCodeChallenge } from "../pkce";
import { insertOAuthState } from "../states";
import { createVault } from "../../vault/index";
import type { Db } from "../../db/index";
import type {
  MailboxConnector,
  TestConnectionParams,
  TestConnectionResult,
} from "../../mailboxes/connectors/types";

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

describe("GET /api/oauth/providers", () => {
  it("returns the microsoft provider when both Microsoft keys are configured", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const { token } = await createUserWithSession(
        db,
        "olive@example.com",
        "Olive Example",
      );

      const app = oauthRoutes(db, {
        MICROSOFT_CLIENT_ID: "ms-id",
        MICROSOFT_CLIENT_SECRET: "ms-secret",
      });
      const res = await app.request("/api/oauth/providers", {
        headers: { cookie: `pigeon_session=${token}` },
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { providers: unknown[] };
      expect(body).toEqual({
        providers: [
          {
            id: "microsoft",
            label: "Outlook / Hotmail",
            startPath: "/api/oauth/microsoft/start",
          },
        ],
      });
    } finally {
      await close();
    }
  });

  it("returns an empty list when Microsoft is not configured", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const { token } = await createUserWithSession(
        db,
        "olive@example.com",
        "Olive Example",
      );
      const cookie = { headers: { cookie: `pigeon_session=${token}` } };

      const noneConfiguredApp = oauthRoutes(db, {});
      const noneConfiguredRes = await noneConfiguredApp.request(
        "/api/oauth/providers",
        cookie,
      );
      expect(noneConfiguredRes.status).toBe(200);
      expect(await noneConfiguredRes.json()).toEqual({ providers: [] });

      const idOnlyApp = oauthRoutes(db, { MICROSOFT_CLIENT_ID: "ms-id" });
      const idOnlyRes = await idOnlyApp.request("/api/oauth/providers", cookie);
      expect(idOnlyRes.status).toBe(200);
      expect(await idOnlyRes.json()).toEqual({ providers: [] });
    } finally {
      await close();
    }
  });

  it("rejects a request with no session cookie: 401", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);

      const app = oauthRoutes(db, {});
      const res = await app.request("/api/oauth/providers");

      expect(res.status).toBe(401);
    } finally {
      await close();
    }
  });
});

describe("GET /api/oauth/microsoft/start", () => {
  const config = {
    MICROSOFT_CLIENT_ID: "ms-id",
    MICROSOFT_CLIENT_SECRET: "ms-secret",
    APP_BASE_URL: "https://app.example.com",
  };

  it("redirects (302) to the Microsoft authorize URL with correct PKCE/scope/redirect params", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const { token } = await createUserWithSession(
        db,
        "olive@example.com",
        "Olive Example",
      );

      const app = oauthRoutes(db, config);
      const res = await app.request("/api/oauth/microsoft/start", {
        headers: { cookie: `pigeon_session=${token}` },
      });

      expect(res.status).toBe(302);
      const loc = new URL(res.headers.get("location")!);
      expect(loc.origin + loc.pathname).toBe(
        "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
      );
      expect(loc.searchParams.get("client_id")).toBe("ms-id");
      expect(loc.searchParams.get("redirect_uri")).toBe(
        "https://app.example.com/api/oauth/microsoft/callback",
      );
      expect(loc.searchParams.get("scope")).toBe(MICROSOFT_SCOPE);
      expect(loc.searchParams.get("code_challenge_method")).toBe("S256");
      expect(loc.searchParams.get("response_type")).toBe("code");
      expect(loc.searchParams.get("state")).toBeTruthy();
      expect(loc.searchParams.get("code_challenge")).toBeTruthy();
    } finally {
      await close();
    }
  });

  it("inserts exactly one oauth_states row for the session user, matching the redirect's state + code_challenge", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const { userId, token } = await createUserWithSession(
        db,
        "olive@example.com",
        "Olive Example",
      );

      const app = oauthRoutes(db, config);
      const res = await app.request("/api/oauth/microsoft/start", {
        headers: { cookie: `pigeon_session=${token}` },
      });
      const loc = new URL(res.headers.get("location")!);

      const rows = await db.query`
        SELECT state, user_id, code_verifier, expires_at FROM oauth_states
      `;
      expect(rows).toHaveLength(1);
      const row = rows[0]!;
      expect(String(row.user_id)).toBe(userId);
      expect(String(row.state)).toBe(loc.searchParams.get("state"));
      expect(computeCodeChallenge(String(row.code_verifier))).toBe(
        loc.searchParams.get("code_challenge"),
      );
      expect(new Date(String(row.expires_at)).getTime()).toBeGreaterThan(
        Date.now(),
      );
    } finally {
      await close();
    }
  });

  it("rejects unauthenticated start with 401", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);

      const app = oauthRoutes(db, config);
      const res = await app.request("/api/oauth/microsoft/start");

      expect(res.status).toBe(401);

      const rows = await db.query`SELECT state FROM oauth_states`;
      expect(rows).toHaveLength(0);
    } finally {
      await close();
    }
  });
});

/** Builds an unsigned JWT (alg "none") carrying `claims`, matching the shape of a real Microsoft `id_token`. */
function makeIdToken(claims: Record<string, unknown>): string {
  const header = Buffer.from(
    JSON.stringify({ alg: "none", typ: "JWT" }),
  ).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${header}.${payload}.`;
}

describe("GET /api/oauth/microsoft/callback", () => {
  const TEST_VAULT_KEY = "J371VUEASEUQsYjxvMKhAklLcZOslC7QAGV9/NWQTbY=";

  it("exchanges the code, seals the refresh token, creates a syncing mailbox row, and redirects to the dashboard", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const vault = createVault(TEST_VAULT_KEY);
      const { userId, token } = await createUserWithSession(
        db,
        "olive@example.com",
        "Olive Example",
      );

      await insertOAuthState(db, {
        state: "state-abc",
        userId,
        codeVerifier: "verifier-xyz",
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      });

      const exchangeScope =
        "offline_access openid email https://outlook.office.com/IMAP.AccessAsUser.All";
      const calledForms: URLSearchParams[] = [];
      const post: TokenPoster = async (_url, form) => {
        calledForms.push(form);
        return {
          ok: true,
          status: 200,
          json: async () => ({
            access_token: "access-tok",
            refresh_token: "refresh-tok",
            scope: exchangeScope,
            id_token: makeIdToken({ email: "connected@outlook.com" }),
          }),
        };
      };

      let capturedParams: TestConnectionParams | undefined;
      const connector: MailboxConnector = {
        testConnection: async (params): Promise<TestConnectionResult> => {
          capturedParams = params;
          return { ok: true };
        },
        listMessageIds: async () => ({ ok: false, reason: "unused" }),
        fetchMessages: async () => ({ ok: false, reason: "unused" }),
      };

      const app = oauthRoutes(
        db,
        {
          MICROSOFT_CLIENT_ID: "ms-id",
          MICROSOFT_CLIENT_SECRET: "ms-secret",
          APP_BASE_URL: "https://app.example.com",
        },
        { vault, post, connector },
      );

      const res = await app.request(
        "/api/oauth/microsoft/callback?code=auth-code-123&state=state-abc",
        { headers: { cookie: `pigeon_session=${token}` } },
      );

      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe(
        "https://app.example.com/?connected=outlook",
      );
      expect(calledForms).toHaveLength(1);

      const mailboxRows = await db.query`
        SELECT provider, protocol, host, port, tls, address, username, label,
               oauth_scope, password_ciphertext, oauth_refresh_ciphertext, status
        FROM mailboxes WHERE user_id = ${userId}
      `;
      expect(mailboxRows).toHaveLength(1);
      const row = mailboxRows[0]!;
      expect(row.provider).toBe("outlook");
      expect(row.protocol).toBe("microsoft-oauth");
      expect(row.host).toBe("outlook.office365.com");
      expect(row.port).toBe(993);
      expect(row.tls).toBe(true);
      expect(row.address).toBe("connected@outlook.com");
      expect(row.username).toBe("connected@outlook.com");
      expect(row.label).toBe("connected@outlook.com");
      expect(row.oauth_scope).toBe(exchangeScope);
      expect(row.password_ciphertext).toBeNull();
      expect(row.oauth_refresh_ciphertext).not.toBeNull();
      expect(String(row.oauth_refresh_ciphertext)).not.toBe("refresh-tok");
      expect(vault.open(String(row.oauth_refresh_ciphertext))).toBe(
        "refresh-tok",
      );
      expect(row.status).toBe("syncing");

      const stateRows = await db.query`
        SELECT state FROM oauth_states WHERE state = 'state-abc'
      `;
      expect(stateRows).toHaveLength(0);

      expect(capturedParams).toBeDefined();
      expect(capturedParams).toMatchObject({
        accessToken: "access-tok",
        username: "connected@outlook.com",
        host: "outlook.office365.com",
        port: 993,
      });
    } finally {
      await close();
    }
  });

  it("rejects a missing/expired state without creating a mailbox", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const vault = createVault(TEST_VAULT_KEY);
      const { userId, token } = await createUserWithSession(
        db,
        "olive@example.com",
        "Olive Example",
      );

      await insertOAuthState(db, {
        state: "expired-state",
        userId,
        codeVerifier: "verifier-xyz",
        expiresAt: new Date(Date.now() - 60 * 1000),
      });

      const post: TokenPoster = async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          access_token: "access-tok",
          refresh_token: "refresh-tok",
          scope: "offline_access openid email",
          id_token: makeIdToken({ email: "connected@outlook.com" }),
        }),
      });
      const connector: MailboxConnector = {
        testConnection: async (): Promise<TestConnectionResult> => ({
          ok: true,
        }),
        listMessageIds: async () => ({ ok: false, reason: "unused" }),
        fetchMessages: async () => ({ ok: false, reason: "unused" }),
      };

      const app = oauthRoutes(
        db,
        {
          MICROSOFT_CLIENT_ID: "ms-id",
          MICROSOFT_CLIENT_SECRET: "ms-secret",
          APP_BASE_URL: "https://app.example.com",
        },
        { vault, post, connector },
      );

      const res = await app.request(
        "/api/oauth/microsoft/callback?code=c&state=expired-state",
        { headers: { cookie: `pigeon_session=${token}` } },
      );

      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe(
        "https://app.example.com/?connected=error",
      );

      const mailboxRows = await db.query`
        SELECT count(*) AS count FROM mailboxes WHERE user_id = ${userId}
      `;
      expect(Number(mailboxRows[0]!.count)).toBe(0);
    } finally {
      await close();
    }
  });

  it("rejects a state whose user_id differs from the session user (CSRF)", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const vault = createVault(TEST_VAULT_KEY);
      const { userId: userAId, token: userAToken } =
        await createUserWithSession(db, "olive@example.com", "Olive Example");
      const { userId: userBId } = await createUserWithSession(
        db,
        "basil@example.com",
        "Basil Example",
      );

      await insertOAuthState(db, {
        state: "foreign-state",
        userId: userBId,
        codeVerifier: "verifier-xyz",
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      });

      const post: TokenPoster = async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          access_token: "access-tok",
          refresh_token: "refresh-tok",
          scope: "offline_access openid email",
          id_token: makeIdToken({ email: "connected@outlook.com" }),
        }),
      });
      const connector: MailboxConnector = {
        testConnection: async (): Promise<TestConnectionResult> => ({
          ok: true,
        }),
        listMessageIds: async () => ({ ok: false, reason: "unused" }),
        fetchMessages: async () => ({ ok: false, reason: "unused" }),
      };

      const app = oauthRoutes(
        db,
        {
          MICROSOFT_CLIENT_ID: "ms-id",
          MICROSOFT_CLIENT_SECRET: "ms-secret",
          APP_BASE_URL: "https://app.example.com",
        },
        { vault, post, connector },
      );

      const res = await app.request(
        "/api/oauth/microsoft/callback?code=c&state=foreign-state",
        { headers: { cookie: `pigeon_session=${userAToken}` } },
      );

      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe(
        "https://app.example.com/?connected=error",
      );

      const mailboxRows = await db.query`
        SELECT count(*) AS count FROM mailboxes WHERE user_id IN (${userAId}, ${userBId})
      `;
      expect(Number(mailboxRows[0]!.count)).toBe(0);
    } finally {
      await close();
    }
  });

  it("aborts when the code exchange returns no refresh token", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const vault = createVault(TEST_VAULT_KEY);
      const { userId, token } = await createUserWithSession(
        db,
        "olive@example.com",
        "Olive Example",
      );

      await insertOAuthState(db, {
        state: "state-no-refresh",
        userId,
        codeVerifier: "verifier-xyz",
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      });

      const post: TokenPoster = async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          access_token: "a",
          scope: "offline_access openid email",
          id_token: makeIdToken({ email: "x@outlook.com" }),
        }),
      });
      const connector: MailboxConnector = {
        testConnection: async (): Promise<TestConnectionResult> => ({
          ok: true,
        }),
        listMessageIds: async () => ({ ok: false, reason: "unused" }),
        fetchMessages: async () => ({ ok: false, reason: "unused" }),
      };

      const app = oauthRoutes(
        db,
        {
          MICROSOFT_CLIENT_ID: "ms-id",
          MICROSOFT_CLIENT_SECRET: "ms-secret",
          APP_BASE_URL: "https://app.example.com",
        },
        { vault, post, connector },
      );

      const res = await app.request(
        "/api/oauth/microsoft/callback?code=c&state=state-no-refresh",
        { headers: { cookie: `pigeon_session=${token}` } },
      );

      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe(
        "https://app.example.com/?connected=error",
      );

      const mailboxRows = await db.query`
        SELECT count(*) AS count FROM mailboxes WHERE user_id = ${userId}
      `;
      expect(Number(mailboxRows[0]!.count)).toBe(0);
    } finally {
      await close();
    }
  });

  it("aborts when the IMAP XOAUTH2 verify fails, without persisting a mailbox", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const vault = createVault(TEST_VAULT_KEY);
      const { userId, token } = await createUserWithSession(
        db,
        "olive@example.com",
        "Olive Example",
      );

      await insertOAuthState(db, {
        state: "state-verify-fail",
        userId,
        codeVerifier: "verifier-xyz",
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      });

      const post: TokenPoster = async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          access_token: "access-tok",
          refresh_token: "refresh-tok",
          scope: "offline_access openid email",
          id_token: makeIdToken({ email: "connected@outlook.com" }),
        }),
      });
      const connector: MailboxConnector = {
        testConnection: async (): Promise<TestConnectionResult> => ({
          ok: false,
          reason: "authentication failed",
        }),
        listMessageIds: async () => ({ ok: false, reason: "unused" }),
        fetchMessages: async () => ({ ok: false, reason: "unused" }),
      };

      const app = oauthRoutes(
        db,
        {
          MICROSOFT_CLIENT_ID: "ms-id",
          MICROSOFT_CLIENT_SECRET: "ms-secret",
          APP_BASE_URL: "https://app.example.com",
        },
        { vault, post, connector },
      );

      const res = await app.request(
        "/api/oauth/microsoft/callback?code=c&state=state-verify-fail",
        { headers: { cookie: `pigeon_session=${token}` } },
      );

      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe(
        "https://app.example.com/?connected=error",
      );

      const mailboxRows = await db.query`
        SELECT count(*) AS count FROM mailboxes WHERE user_id = ${userId}
      `;
      expect(Number(mailboxRows[0]!.count)).toBe(0);
    } finally {
      await close();
    }
  });

  it("returns a clean 'already connected' outcome for an address already connected by the same user (no 500, no duplicate row)", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const vault = createVault(TEST_VAULT_KEY);
      const { userId, token } = await createUserWithSession(
        db,
        "olive@example.com",
        "Olive Example",
      );

      await db.query`
        INSERT INTO mailboxes (user_id, provider, protocol, label, address, host, port, tls, username, oauth_refresh_ciphertext, oauth_scope, status)
        VALUES (${userId}, 'outlook', 'microsoft-oauth', 'connected@outlook.com', 'connected@outlook.com', 'outlook.office365.com', 993, true, 'connected@outlook.com', ${vault.seal("old-refresh")}, 'old-scope', 'syncing')
      `;

      await insertOAuthState(db, {
        state: "state-already-connected",
        userId,
        codeVerifier: "verifier-xyz",
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      });

      const post: TokenPoster = async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          access_token: "access-tok",
          refresh_token: "refresh-tok-2",
          scope: "offline_access openid email",
          id_token: makeIdToken({ email: "connected@outlook.com" }),
        }),
      });
      const connector: MailboxConnector = {
        testConnection: async (): Promise<TestConnectionResult> => ({
          ok: true,
        }),
        listMessageIds: async () => ({ ok: false, reason: "unused" }),
        fetchMessages: async () => ({ ok: false, reason: "unused" }),
      };

      const app = oauthRoutes(
        db,
        {
          MICROSOFT_CLIENT_ID: "ms-id",
          MICROSOFT_CLIENT_SECRET: "ms-secret",
          APP_BASE_URL: "https://app.example.com",
        },
        { vault, post, connector },
      );

      const res = await app.request(
        "/api/oauth/microsoft/callback?code=c&state=state-already-connected",
        { headers: { cookie: `pigeon_session=${token}` } },
      );

      expect(res.status).not.toBe(500);
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe(
        "https://app.example.com/?connected=already",
      );

      const mailboxRows = await db.query`
        SELECT count(*) AS count FROM mailboxes
        WHERE user_id = ${userId} AND address = 'connected@outlook.com'
      `;
      expect(Number(mailboxRows[0]!.count)).toBe(1);
    } finally {
      await close();
    }
  });

  it("reconnects an errored mailbox in place: rotates the sealed refresh token and resets status to syncing on the same row", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const vault = createVault(TEST_VAULT_KEY);
      const { userId, token } = await createUserWithSession(
        db,
        "olive@example.com",
        "Olive Example",
      );

      const existing = await db.query`
        INSERT INTO mailboxes (
          user_id, provider, protocol, label, address, host, port, tls,
          username, oauth_refresh_ciphertext, oauth_scope, status
        ) VALUES (
          ${userId}, 'outlook', 'microsoft-oauth', 'connected@outlook.com', 'connected@outlook.com',
          'outlook.office365.com', 993, true, 'connected@outlook.com',
          ${vault.seal("old-refresh")}, 'old-scope', 'error'
        ) RETURNING id
      `;
      const existingId = String(existing[0]!.id);

      await insertOAuthState(db, {
        state: "reconnect-state",
        userId,
        codeVerifier: "verifier-xyz",
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      });

      const post: TokenPoster = async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          access_token: "new-access",
          refresh_token: "new-refresh",
          scope: "new-scope",
          id_token: makeIdToken({ email: "connected@outlook.com" }),
        }),
      });
      const connector: MailboxConnector = {
        testConnection: async (): Promise<TestConnectionResult> => ({
          ok: true,
        }),
        listMessageIds: async () => ({ ok: false, reason: "unused" }),
        fetchMessages: async () => ({ ok: false, reason: "unused" }),
      };

      const app = oauthRoutes(
        db,
        {
          MICROSOFT_CLIENT_ID: "ms-id",
          MICROSOFT_CLIENT_SECRET: "ms-secret",
          APP_BASE_URL: "https://app.example.com",
        },
        { vault, post, connector },
      );

      const res = await app.request(
        "/api/oauth/microsoft/callback?code=c&state=reconnect-state",
        { headers: { cookie: `pigeon_session=${token}` } },
      );

      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe(
        "https://app.example.com/?connected=outlook",
      );

      const mailboxRows = await db.query`
        SELECT id, status, oauth_scope, oauth_refresh_ciphertext FROM mailboxes
        WHERE user_id = ${userId} AND address = 'connected@outlook.com'
      `;
      expect(mailboxRows).toHaveLength(1);
      const row = mailboxRows[0]!;
      expect(String(row.id)).toBe(existingId);
      expect(row.status).toBe("syncing");
      expect(row.oauth_scope).toBe("new-scope");
      expect(vault.open(String(row.oauth_refresh_ciphertext))).toBe(
        "new-refresh",
      );
    } finally {
      await close();
    }
  });
});

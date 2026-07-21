/**
 * Integration tests for login, /me, logout, and session lifecycle
 * (Authentication & User Accounts PRD FR-13..FR-20; AC-2, AC-5, AC-8).
 *
 * Each test boots its own embedded Postgres cluster via `withTestDb`, runs
 * migrations, mounts the auth router as `app = authRoutes(db, mail)`, and
 * drives it through Hono's in-process `app.request` API — same harness as
 * `signup-verify.test.ts`. Sessions are minted through the real HTTP surface
 * (signup -> verify -> login) wherever practical; the sliding-renewal tests
 * reach into the `sessions` table directly to age a row without waiting.
 *
 * RED note: at authoring time `POST /api/auth/login`, `GET /api/auth/me`, and
 * `POST /api/auth/logout` are NOT mounted on the router `authRoutes` returns
 * (only signup/verify/resend are). Hono's default 404 handler answers every
 * request to these paths, so every test below is expected to fail on its
 * first status assertion (expecting 200/401, receiving 404) until those
 * routes and the session-lookup/renewal logic behind them are implemented.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { withTestDb } from "../../../test/db";
import { runMigrations } from "../../migrate/runner";
import { authRoutes } from "../routes";
import { createMailSender } from "../../mail/index";
import { mockMail } from "../../mail/mock";
import { generateInviteCode, hashToken } from "../tokens";
import type { Db } from "../../db/index";

const ORIGIN = "http://localhost:4321";
const JSON_HEADERS = { "content-type": "application/json", origin: ORIGIN };

/** Minimal shape of an error/status JSON response body, for `.json()` casts. */
type ErrorBody = { error?: string; code?: string };

/** Minimal shape of a { user } JSON response body, for `.json()` casts. */
type UserBody = { user: { email: string; name: string } };

/** Build the mock-backed mail sender the router uses (test env, no API key). */
function mailForTest() {
  return createMailSender({
    NODE_ENV: "test" as const,
    APP_BASE_URL: ORIGIN,
    MAIL_FROM: "p@pigeon.email",
  });
}

/**
 * Mint a single-use invite row the way the invite CLI will: generate a base32
 * code, store only its sha256 `code_hash`, and return the plaintext code so
 * the test can hand it to the sign-up endpoint.
 */
async function mintInvite(db: Db): Promise<string> {
  const code = generateInviteCode();
  const codeHash = hashToken(code);
  await db.query`INSERT INTO invites(code_hash, expires_at) VALUES (${codeHash}, ${null})`;
  return code;
}

/** Build a sign-up JSON body string. */
function signupBody(opts: {
  email: string;
  password: string;
  name: string;
  inviteCode: string;
}): string {
  return JSON.stringify(opts);
}

/** Build a login JSON body string. */
function loginBody(email: string, password: string): string {
  return JSON.stringify({ email, password });
}

/** Pull the verify token out of a captured email's html body. */
function extractVerifyToken(html: string): string {
  const m = html.match(/verify\?token=([A-Za-z0-9_-]+)/);
  if (!m) throw new Error(`no verify token in email html: ${html}`);
  return m[1]!;
}

/**
 * Pull the `pigeon_session=<token>` pair off a response's `Set-Cookie`
 * header, ready to hand straight back as the next request's `Cookie` header.
 * Hono's test client has no cookie jar of its own (unlike a browser), so
 * tests that need to reuse a session must round-trip it manually like this.
 */
function extractSessionCookiePair(res: Response): string {
  const setCookie = res.headers.get("set-cookie");
  if (!setCookie) throw new Error("response has no set-cookie header");
  const pair = setCookie.split(";")[0]?.trim();
  if (!pair || !pair.startsWith("pigeon_session=")) {
    throw new Error(`unexpected set-cookie shape: ${setCookie}`);
  }
  return pair;
}

/**
 * Drive a full sign-up + verify-email flow so a real verified user with a
 * known email/password exists in the DB, ready for the test to log in with.
 * Assumes the outbox has been cleared just before (via `beforeEach`).
 */
async function signupAndVerify(
  app: ReturnType<typeof authRoutes>,
  email: string,
  password: string,
  name: string,
  inviteCode: string,
): Promise<void> {
  const sres = await app.request("/api/auth/signup", {
    method: "POST",
    body: signupBody({ email, password, name, inviteCode }),
    headers: JSON_HEADERS,
  });
  expect(sres.status).toBe(202);

  const token = extractVerifyToken(mockMail.outbox()[0]?.html ?? "");
  const vres = await app.request("/api/auth/verify", {
    method: "POST",
    body: JSON.stringify({ token }),
    headers: JSON_HEADERS,
  });
  expect(vres.status).toBe(200);
}

describe("login + /me + logout + session lifecycle", () => {
  beforeEach(() => {
    mockMail.clear();
  });

  // FR-13..FR-15, AC-2: verified user + correct password -> 200 { user } and
  // a properly-shaped session cookie (no `Secure` yet — dev/test only, per
  // the same note as the verify-email route in ../routes.ts).
  it("login with a verified user and correct password returns 200 { user } and sets a proper session cookie", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const app = authRoutes(db, mailForTest());
      const email = "ada@example.com";
      const password = "supersecret-1";
      await signupAndVerify(app, email, password, "Ada", await mintInvite(db));

      const res = await app.request("/api/auth/login", {
        method: "POST",
        body: loginBody(email, password),
        headers: JSON_HEADERS,
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as UserBody;
      expect(body.user.email).toBe(email);

      const setCookie = res.headers.get("set-cookie");
      expect(setCookie).toContain("pigeon_session=");
      expect(setCookie).toContain("HttpOnly");
      expect(setCookie).toContain("SameSite=Lax");
      expect(setCookie).toContain("Path=/");
      expect(setCookie).not.toContain("Secure");
    } finally {
      await close();
    }
  });

  // AC-2/AC-3: a nonexistent email must 401 identically to a bad password,
  // to avoid revealing whether an account exists.
  it("login with a nonexistent email returns 401 bad_credentials", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const app = authRoutes(db, mailForTest());

      const res = await app.request("/api/auth/login", {
        method: "POST",
        body: loginBody("nobody@example.com", "whatever-pw-1"),
        headers: JSON_HEADERS,
      });

      expect(res.status).toBe(401);
      const body = (await res.json()) as ErrorBody;
      expect(body.code).toBe("bad_credentials");
    } finally {
      await close();
    }
  });

  // AC-2/AC-3: an unverified account with the CORRECT password must still
  // 401 identically — the caller can't distinguish "unverified" from
  // "doesn't exist" from "wrong password".
  it("login with an unverified user and the correct password returns the same 401 bad_credentials as an unknown email", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const app = authRoutes(db, mailForTest());
      const email = "unverified@example.com";
      const password = "supersecret-1";
      const code = await mintInvite(db);

      const sres = await app.request("/api/auth/signup", {
        method: "POST",
        body: signupBody({
          email,
          password,
          name: "Unverified",
          inviteCode: code,
        }),
        headers: JSON_HEADERS,
      });
      expect(sres.status).toBe(202);

      const res = await app.request("/api/auth/login", {
        method: "POST",
        body: loginBody(email, password),
        headers: JSON_HEADERS,
      });

      expect(res.status).toBe(401);
      const body = (await res.json()) as ErrorBody;
      expect(body.code).toBe("bad_credentials");
    } finally {
      await close();
    }
  });

  // AC-2/AC-3: a verified account with the WRONG password is the third
  // identical-401 case.
  it("login with a verified user and the wrong password returns the same 401 bad_credentials again", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const app = authRoutes(db, mailForTest());
      const email = "ada2@example.com";
      const password = "supersecret-1";
      await signupAndVerify(app, email, password, "Ada", await mintInvite(db));

      const res = await app.request("/api/auth/login", {
        method: "POST",
        body: loginBody(email, "totally-wrong-pw"),
        headers: JSON_HEADERS,
      });

      expect(res.status).toBe(401);
      const body = (await res.json()) as ErrorBody;
      expect(body.code).toBe("bad_credentials");
    } finally {
      await close();
    }
  });

  // FR-17/FR-18: a valid session cookie minted by login authenticates /me.
  it("GET /me with a valid session cookie from login returns 200 { user } for the logged-in user", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const app = authRoutes(db, mailForTest());
      const email = "ada3@example.com";
      const password = "supersecret-1";
      await signupAndVerify(app, email, password, "Ada", await mintInvite(db));

      const lres = await app.request("/api/auth/login", {
        method: "POST",
        body: loginBody(email, password),
        headers: JSON_HEADERS,
      });
      expect(lres.status).toBe(200);
      const cookie = extractSessionCookiePair(lres);

      const meRes = await app.request("/api/auth/me", { headers: { cookie } });

      expect(meRes.status).toBe(200);
      const body = (await meRes.json()) as UserBody;
      expect(body.user.email).toBe(email);
    } finally {
      await close();
    }
  });

  // FR-18: no session cookie at all -> 401 unauthenticated.
  it("GET /me with no session cookie returns 401 unauthenticated", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const app = authRoutes(db, mailForTest());

      const res = await app.request("/api/auth/me");

      expect(res.status).toBe(401);
      const body = (await res.json()) as ErrorBody;
      expect(body.code).toBe("unauthenticated");
    } finally {
      await close();
    }
  });

  // FR-19: logout revokes the session; the same cookie no longer
  // authenticates a subsequent /me call.
  it("logout revokes the session so the same cookie no longer authenticates /me", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const app = authRoutes(db, mailForTest());
      const email = "ada4@example.com";
      const password = "supersecret-1";
      await signupAndVerify(app, email, password, "Ada", await mintInvite(db));

      const lres = await app.request("/api/auth/login", {
        method: "POST",
        body: loginBody(email, password),
        headers: JSON_HEADERS,
      });
      const cookie = extractSessionCookiePair(lres);

      const logoutRes = await app.request("/api/auth/logout", {
        method: "POST",
        headers: { ...JSON_HEADERS, cookie },
      });
      expect(logoutRes.status).toBe(200);

      const meRes = await app.request("/api/auth/me", { headers: { cookie } });
      expect(meRes.status).toBe(401);
    } finally {
      await close();
    }
  });

  // FR-16: sliding renewal — a session idle for 5 days (within the 30-day
  // idle window) still authenticates, and the `/me` call itself advances
  // `expires_at` further out (the sliding renewal touched the row).
  it("a session idle for 5 days still authenticates /me and its expires_at advances", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const app = authRoutes(db, mailForTest());
      const email = "ada5@example.com";
      const password = "supersecret-1";
      await signupAndVerify(app, email, password, "Ada", await mintInvite(db));

      const lres = await app.request("/api/auth/login", {
        method: "POST",
        body: loginBody(email, password),
        headers: JSON_HEADERS,
      });
      const cookie = extractSessionCookiePair(lres);
      const token = cookie.split("=")[1]!;
      const tokenHash = hashToken(token);

      await db.query`
        UPDATE sessions SET last_seen_at = now() - interval '5 days'
        WHERE token_hash = ${tokenHash}
      `;
      const before =
        await db.query`SELECT expires_at FROM sessions WHERE token_hash = ${tokenHash}`;
      const expiresAtBefore = before[0]?.expires_at;

      const meRes = await app.request("/api/auth/me", { headers: { cookie } });
      expect(meRes.status).toBe(200);

      const after =
        await db.query`SELECT expires_at FROM sessions WHERE token_hash = ${tokenHash}`;
      const expiresAtAfter = after[0]?.expires_at;
      expect(new Date(expiresAtAfter as string).getTime()).toBeGreaterThan(
        new Date(expiresAtBefore as string).getTime(),
      );
    } finally {
      await close();
    }
  });

  // FR-16: absolute cap — a session created 91 days ago is rejected outright
  // even though it looks recently active (last_seen_at untouched).
  it("a session created 91 days ago is rejected by the 90-day absolute cap", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const app = authRoutes(db, mailForTest());
      const email = "ada6@example.com";
      const password = "supersecret-1";
      await signupAndVerify(app, email, password, "Ada", await mintInvite(db));

      const lres = await app.request("/api/auth/login", {
        method: "POST",
        body: loginBody(email, password),
        headers: JSON_HEADERS,
      });
      const cookie = extractSessionCookiePair(lres);
      const token = cookie.split("=")[1]!;
      const tokenHash = hashToken(token);

      await db.query`
        UPDATE sessions SET created_at = now() - interval '91 days'
        WHERE token_hash = ${tokenHash}
      `;

      const meRes = await app.request("/api/auth/me", { headers: { cookie } });
      expect(meRes.status).toBe(401);
    } finally {
      await close();
    }
  });

  // FR-16: idle timeout — a session untouched for 31 days is rejected even
  // though it's well within the 90-day absolute cap.
  it("a session idle for 31 days is rejected by the 30-day idle timeout", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const app = authRoutes(db, mailForTest());
      const email = "ada7@example.com";
      const password = "supersecret-1";
      await signupAndVerify(app, email, password, "Ada", await mintInvite(db));

      const lres = await app.request("/api/auth/login", {
        method: "POST",
        body: loginBody(email, password),
        headers: JSON_HEADERS,
      });
      const cookie = extractSessionCookiePair(lres);
      const token = cookie.split("=")[1]!;
      const tokenHash = hashToken(token);

      await db.query`
        UPDATE sessions SET last_seen_at = now() - interval '31 days'
        WHERE token_hash = ${tokenHash}
      `;

      const meRes = await app.request("/api/auth/me", { headers: { cookie } });
      expect(meRes.status).toBe(401);
    } finally {
      await close();
    }
  });
});

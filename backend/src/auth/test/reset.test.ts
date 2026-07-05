/**
 * Integration tests for the password-reset request/confirm loop
 * (Authentication & User Accounts PRD §3.1.8 FR-21..FR-23; AC-6).
 *
 * Each test boots its own embedded Postgres cluster via `withTestDb`, runs
 * migrations, mounts the auth router as `app = authRoutes(db, mail)`, and
 * drives it through Hono's in-process `app.request` API — same harness as
 * `sessions-login.test.ts` and `signup-verify.test.ts`. `mockMail` captures
 * every outbound email in an in-process outbox that the tests assert on.
 *
 * Scope: ONLY `POST /api/auth/password/reset-request` and
 * `POST /api/auth/password/reset`. Sign-up/verify/resend and login/me/logout
 * belong to their own test files; this file only drives those flows as setup
 * (via `signupAndVerify` and direct login calls) to get a real verified user
 * and live session cookies to reset against.
 *
 * RED note: at authoring time neither `/api/auth/password/reset-request` nor
 * `/api/auth/password/reset` are mounted on the router `authRoutes` returns.
 * Hono's default 404 handler answers every request to these paths, so every
 * test below is expected to fail on its first status assertion (expecting
 * 202/200/400, receiving 404) until those routes and the underlying
 * request/confirm service logic are implemented.
 *
 * Path note: this file lives at `backend/src/auth/test/`, two levels below
 * `backend/src/`, so the harness/runner/db imports climb three levels
 * (`../../../test/db`), not two.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { withTestDb } from "../../../test/db";
import { runMigrations } from "../../migrate/runner";
import { authRoutes } from "../routes";
import { createMailSender } from "../../mail/index";
import { mockMail } from "../../mail/mock";
import { generateInviteCode, generateToken, hashToken } from "../tokens";
import type { Db } from "../../db/index";

const ORIGIN = "http://localhost:4321";
const JSON_HEADERS = { "content-type": "application/json", origin: ORIGIN };

/** Minimal shape of an error/status JSON response body, for `.json()` casts. */
type ErrorBody = { error?: string; code?: string };

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

/** Build a reset-request JSON body string. */
function resetRequestBody(email: string): string {
  return JSON.stringify({ email });
}

/** Build a reset-confirm JSON body string. */
function resetConfirmBody(token: string, newPassword: string): string {
  return JSON.stringify({ token, newPassword });
}

/** Pull the verify token out of a captured email's html body. */
function extractVerifyToken(html: string): string {
  const m = html.match(/verify\?token=([A-Za-z0-9_-]+)/);
  if (!m) throw new Error(`no verify token in email html: ${html}`);
  return m[1]!;
}

/** Pull the reset-password token out of a captured email's html body. */
function extractResetToken(html: string): string {
  const m = html.match(/reset-password\?token=([A-Za-z0-9_-]+)/);
  if (!m) throw new Error(`no reset token in email html: ${html}`);
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

/** Look up a user's id by email, asserting the row exists. */
async function userIdByEmail(db: Db, email: string): Promise<string> {
  const rows = await db.query`SELECT id FROM users WHERE email = ${email}`;
  const id = rows[0]?.id;
  if (!id) throw new Error(`no user for ${email}`);
  return String(id);
}

/**
 * Drive a full sign-up + verify-email flow so a real verified user with a
 * known email/password exists in the DB, ready for the test to reset-request
 * or log in with. Assumes the outbox has been cleared just before (via
 * `beforeEach`).
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

describe("password reset request + confirm", () => {
  beforeEach(() => {
    mockMail.clear();
  });

  // FR-21/FR-22, AC-6: a real verified user gets a fresh reset_password
  // token (~1h TTL, unconsumed) and a reset-link email.
  it("reset-request for a real verified user → 202, mints an unconsumed reset_password token (~1h TTL), and emails a reset link", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const app = authRoutes(db, mailForTest());
      const email = "ada@example.com";
      const password = "supersecret-1";
      await signupAndVerify(app, email, password, "Ada", await mintInvite(db));
      const userId = await userIdByEmail(db, email);
      mockMail.clear(); // isolate the reset email from signup's verify email

      const res = await app.request("/api/auth/password/reset-request", {
        method: "POST",
        body: resetRequestBody(email),
        headers: JSON_HEADERS,
      });

      expect(res.status).toBe(202);

      const rows =
        await db.query`SELECT expires_at, consumed_at FROM auth_tokens WHERE user_id = ${userId} AND kind = 'reset_password'`;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.consumed_at).toBeNull();
      const expiresAtMs = new Date(rows[0]?.expires_at as string).getTime();
      const diffMinutes = (expiresAtMs - Date.now()) / 60000;
      expect(diffMinutes).toBeGreaterThan(55);
      expect(diffMinutes).toBeLessThan(65);

      const outbox = mockMail.outbox();
      expect(outbox).toHaveLength(1);
      expect(outbox[0]?.html).toContain("/reset-password?token=");
    } finally {
      await close();
    }
  });

  // FR-22: no user enumeration — an unknown email 202s identically and sends
  // nothing.
  it("reset-request for a nonexistent email → 202 (no enumeration), no email sent", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const app = authRoutes(db, mailForTest());

      const res = await app.request("/api/auth/password/reset-request", {
        method: "POST",
        body: resetRequestBody("nope@example.com"),
        headers: JSON_HEADERS,
      });

      expect(res.status).toBe(202);
      expect(mockMail.outbox()).toHaveLength(0);
    } finally {
      await close();
    }
  });

  // FR-22: 60s cooldown — a second immediate reset-request for the same
  // user still 202s but must not mint a fresh token or send another email.
  it("reset-request twice immediately for the same user → both 202, but the second is a cooldown no-op (no new token/email)", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const app = authRoutes(db, mailForTest());
      const email = "ada2@example.com";
      await signupAndVerify(
        app,
        email,
        "supersecret-1",
        "Ada",
        await mintInvite(db),
      );
      mockMail.clear();

      const r1 = await app.request("/api/auth/password/reset-request", {
        method: "POST",
        body: resetRequestBody(email),
        headers: JSON_HEADERS,
      });
      expect(r1.status).toBe(202);
      expect(mockMail.outbox()).toHaveLength(1);

      // Immediately again — must still 202 (no enumeration) but must NOT
      // mint a fresh token / send another email (60s cooldown).
      const r2 = await app.request("/api/auth/password/reset-request", {
        method: "POST",
        body: resetRequestBody(email),
        headers: JSON_HEADERS,
      });
      expect(r2.status).toBe(202);
      expect(mockMail.outbox()).toHaveLength(1);
    } finally {
      await close();
    }
  });

  // FR-22: once the cooldown has elapsed, a subsequent reset-request voids
  // the prior outstanding token — at most one unconsumed reset_password
  // token per user, ever. A real 60s wait is avoided by directly inserting a
  // reset_password row that looks like it was voided well outside the
  // cooldown window (mirroring how sessions-login.test.ts backdates
  // `sessions.last_seen_at` via raw SQL instead of waiting real time).
  it("reset-request past the cooldown voids the prior outstanding reset_password token (never more than one unconsumed)", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const app = authRoutes(db, mailForTest());
      const email = "ada3@example.com";
      await signupAndVerify(
        app,
        email,
        "supersecret-1",
        "Ada",
        await mintInvite(db),
      );
      const userId = await userIdByEmail(db, email);

      const r1 = await app.request("/api/auth/password/reset-request", {
        method: "POST",
        body: resetRequestBody(email),
        headers: JSON_HEADERS,
      });
      expect(r1.status).toBe(202);

      // Simulate that a prior reset-request was voided well past the 60s
      // cooldown, the same way the verify-email resend cooldown is gated off
      // the most-recently-voided token's `consumed_at`.
      await db.query`
        INSERT INTO auth_tokens (user_id, kind, token_hash, expires_at, consumed_at)
        VALUES (
          ${userId}, 'reset_password', ${hashToken("stale-past-token")},
          now() - interval '1 hour', now() - interval '2 minutes'
        )
      `;

      const r2 = await app.request("/api/auth/password/reset-request", {
        method: "POST",
        body: resetRequestBody(email),
        headers: JSON_HEADERS,
      });
      expect(r2.status).toBe(202);

      const outstanding =
        await db.query`SELECT count(*)::int AS n FROM auth_tokens WHERE user_id = ${userId} AND kind = 'reset_password' AND consumed_at IS NULL`;
      expect(outstanding).toEqual([{ n: 1 }]);
    } finally {
      await close();
    }
  });

  // FR-23: a valid, unconsumed, unexpired reset token + acceptable new
  // password succeeds, and the new password (not the old one) authenticates.
  it("reset with a valid unconsumed token and an acceptable new password → 200, and login now requires the new password", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const app = authRoutes(db, mailForTest());
      const email = "ada4@example.com";
      const oldPassword = "supersecret-1";
      const newPassword = "brand-new-password-1";
      await signupAndVerify(
        app,
        email,
        oldPassword,
        "Ada",
        await mintInvite(db),
      );
      mockMail.clear();

      const rreq = await app.request("/api/auth/password/reset-request", {
        method: "POST",
        body: resetRequestBody(email),
        headers: JSON_HEADERS,
      });
      expect(rreq.status).toBe(202);
      const token = extractResetToken(mockMail.outbox()[0]?.html ?? "");

      const rconfirm = await app.request("/api/auth/password/reset", {
        method: "POST",
        body: resetConfirmBody(token, newPassword),
        headers: JSON_HEADERS,
      });
      expect(rconfirm.status).toBe(200);

      const loginNew = await app.request("/api/auth/login", {
        method: "POST",
        body: loginBody(email, newPassword),
        headers: JSON_HEADERS,
      });
      expect(loginNew.status).toBe(200);

      const loginOld = await app.request("/api/auth/login", {
        method: "POST",
        body: loginBody(email, oldPassword),
        headers: JSON_HEADERS,
      });
      expect(loginOld.status).toBe(401);
      const body = (await loginOld.json()) as ErrorBody;
      expect(body.code).toBe("bad_credentials");
    } finally {
      await close();
    }
  });

  // FR-23, AC-6: the key security property — resetting the password revokes
  // ALL of the user's existing sessions, not just the one used to request
  // the reset (there isn't one here) or a single "current" session.
  it("a successful password reset revokes ALL of the user's existing sessions, not just one", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const app = authRoutes(db, mailForTest());
      const email = "ada5@example.com";
      const oldPassword = "supersecret-1";
      const newPassword = "brand-new-password-2";
      const inviteCode = await mintInvite(db);

      const sres = await app.request("/api/auth/signup", {
        method: "POST",
        body: signupBody({
          email,
          password: oldPassword,
          name: "Ada",
          inviteCode,
        }),
        headers: JSON_HEADERS,
      });
      expect(sres.status).toBe(202);
      const verifyToken = extractVerifyToken(mockMail.outbox()[0]?.html ?? "");
      const vres = await app.request("/api/auth/verify", {
        method: "POST",
        body: JSON.stringify({ token: verifyToken }),
        headers: JSON_HEADERS,
      });
      expect(vres.status).toBe(200);
      const cookie1 = extractSessionCookiePair(vres); // session #1 (auto-login on verify)

      const lres = await app.request("/api/auth/login", {
        method: "POST",
        body: loginBody(email, oldPassword),
        headers: JSON_HEADERS,
      });
      expect(lres.status).toBe(200);
      const cookie2 = extractSessionCookiePair(lres); // session #2 (a second device)

      // Sanity: both sessions authenticate before the reset.
      const me1Before = await app.request("/api/auth/me", {
        headers: { cookie: cookie1 },
      });
      expect(me1Before.status).toBe(200);
      const me2Before = await app.request("/api/auth/me", {
        headers: { cookie: cookie2 },
      });
      expect(me2Before.status).toBe(200);

      mockMail.clear();
      const rreq = await app.request("/api/auth/password/reset-request", {
        method: "POST",
        body: resetRequestBody(email),
        headers: JSON_HEADERS,
      });
      expect(rreq.status).toBe(202);
      const resetToken = extractResetToken(mockMail.outbox()[0]?.html ?? "");

      const rconfirm = await app.request("/api/auth/password/reset", {
        method: "POST",
        body: resetConfirmBody(resetToken, newPassword),
        headers: JSON_HEADERS,
      });
      expect(rconfirm.status).toBe(200);

      const me1After = await app.request("/api/auth/me", {
        headers: { cookie: cookie1 },
      });
      expect(me1After.status).toBe(401);
      const me2After = await app.request("/api/auth/me", {
        headers: { cookie: cookie2 },
      });
      expect(me2After.status).toBe(401);
    } finally {
      await close();
    }
  });

  // FR-23: reset tokens are single-use.
  it("reset token is single-use: a second reset attempt with the same token → 400 invalid_or_expired_token", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const app = authRoutes(db, mailForTest());
      const email = "ada6@example.com";
      await signupAndVerify(
        app,
        email,
        "supersecret-1",
        "Ada",
        await mintInvite(db),
      );
      mockMail.clear();

      const rreq = await app.request("/api/auth/password/reset-request", {
        method: "POST",
        body: resetRequestBody(email),
        headers: JSON_HEADERS,
      });
      expect(rreq.status).toBe(202);
      const token = extractResetToken(mockMail.outbox()[0]?.html ?? "");

      const r1 = await app.request("/api/auth/password/reset", {
        method: "POST",
        body: resetConfirmBody(token, "first-new-password-1"),
        headers: JSON_HEADERS,
      });
      expect(r1.status).toBe(200);

      const r2 = await app.request("/api/auth/password/reset", {
        method: "POST",
        body: resetConfirmBody(token, "second-new-password-1"),
        headers: JSON_HEADERS,
      });
      expect(r2.status).toBe(400);
      const body = (await r2.json()) as ErrorBody;
      expect(body.code).toBe("invalid_or_expired_token");
    } finally {
      await close();
    }
  });

  // FR-23: an expired reset_password token is rejected the same way a
  // nonexistent/consumed one is.
  it("reset with an expired reset_password token → 400 invalid_or_expired_token", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const app = authRoutes(db, mailForTest());
      const email = "ada7@example.com";
      await signupAndVerify(
        app,
        email,
        "supersecret-1",
        "Ada",
        await mintInvite(db),
      );
      const userId = await userIdByEmail(db, email);

      const token = generateToken();
      const tokenHash = hashToken(token);
      await db.query`
        INSERT INTO auth_tokens (user_id, kind, token_hash, expires_at)
        VALUES (${userId}, 'reset_password', ${tokenHash}, now() - interval '1 minute')
      `;

      const res = await app.request("/api/auth/password/reset", {
        method: "POST",
        body: resetConfirmBody(token, "some-new-password-1"),
        headers: JSON_HEADERS,
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as ErrorBody;
      expect(body.code).toBe("invalid_or_expired_token");
    } finally {
      await close();
    }
  });

  // FR-23: the new password is validated the same way sign-up's is (min 12
  // chars, not denylisted) — a deliberately weak 8-char password 400s.
  it("reset with a valid token but a weak (8-char) new password → 400 invalid_input", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const app = authRoutes(db, mailForTest());
      const email = "ada8@example.com";
      await signupAndVerify(
        app,
        email,
        "supersecret-1",
        "Ada",
        await mintInvite(db),
      );
      mockMail.clear();

      const rreq = await app.request("/api/auth/password/reset-request", {
        method: "POST",
        body: resetRequestBody(email),
        headers: JSON_HEADERS,
      });
      expect(rreq.status).toBe(202);
      const token = extractResetToken(mockMail.outbox()[0]?.html ?? "");

      const res = await app.request("/api/auth/password/reset", {
        method: "POST",
        body: resetConfirmBody(token, "weakpwd1"),
        headers: JSON_HEADERS,
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as ErrorBody;
      expect(body.code).toBe("invalid_input");
    } finally {
      await close();
    }
  });
});

/**
 * Integration tests for the sign-up / verify-email / resend loop
 * (Authentication & User Accounts PRD FR-1..FR-12).
 *
 * Each test boots its own embedded Postgres cluster via `withTestDb`, runs
 * migrations, mounts the auth router as `app = authRoutes(db, mail)`, and
 * drives it through Hono's in-process `app.request` API. `mockMail` captures
 * every outbound email in an in-process outbox that the tests assert on.
 *
 * Scope: ONLY sign-up, verify-email, and resend. Login, /me, logout, and
 * session lifecycle belong to a SEPARATE test file. The only session-related
 * assertion here is that a successful verify sets the `pigeon_session=`
 * `Set-Cookie` header — verified via the Response header, never by calling
 * `/me`.
 *
 * RED note: at authoring time `../routes` does not exist — the import fails
 * and this file cannot resolve to a module. That import failure is the
 * expected RED.
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
import { generateInviteCode, hashToken } from "../tokens";
import type { Db } from "../../db/index";

const ORIGIN = "http://localhost:4321";
const JSON_HEADERS = { "content-type": "application/json", origin: ORIGIN };

/** Minimal shape of an error/status JSON response body, for `.json()` casts. */
type ErrorBody = { error?: string; code?: string; status?: string };

/** Minimal shape of the verify-success JSON response body, for `.json()` casts. */
type VerifyBody = { user: { email: string; name: string } };

/** Build the mock-backed mail sender the router uses (test env, no API key). */
function mailForTest() {
  return createMailSender({
    NODE_ENV: "test" as const,
    APP_BASE_URL: ORIGIN,
    MAIL_FROM: "p@pigeon.email",
  });
}

/**
 * Mint a single-use invite row exactly the way the invite CLI will: generate a
 * base32 code, store only its sha256 `code_hash`, and return the plaintext
 * code so the test can hand it to the sign-up endpoint.
 */
async function mintInvite(
  db: Db,
  opts?: { expiresAt?: Date },
): Promise<string> {
  const code = generateInviteCode();
  const codeHash = hashToken(code);
  const expiresAt: Date | null = opts?.expiresAt ?? null;
  await db.query`INSERT INTO invites(code_hash, expires_at) VALUES (${codeHash}, ${expiresAt})`;
  return code;
}

/** Build a sign-up JSON body string. */
function signupBody(opts: {
  email: string;
  password: string;
  name: string;
  inviteCode: string;
}): string {
  return JSON.stringify({
    email: opts.email,
    password: opts.password,
    name: opts.name,
    inviteCode: opts.inviteCode,
  });
}

/** Pull the verify token T out of a captured email's html body. */
function extractToken(html: string): string {
  const m = html.match(/verify\?token=([A-Za-z0-9_-]+)/);
  if (!m) throw new Error(`no verify token in email html: ${html}`);
  return m[1]!;
}

/** Look up a user's id by email, asserting the row exists. */
async function userIdByEmail(db: Db, email: string): Promise<string> {
  const rows = await db.query`SELECT id FROM users WHERE email = ${email}`;
  const id = rows[0]?.id;
  if (!id) throw new Error(`no user for ${email}`);
  return String(id);
}

/**
 * Drive the full sign-up + verify-email flow for one address and return the
 * plaintext verify token. Used by tests that need a verified account as a
 * precondition (e.g. email-taken). Assumes `app`, `db`, and a minted invite
 * code are already set up, and that the outbox has been cleared just before.
 */
async function fullSignupAndVerify(
  app: ReturnType<typeof authRoutes>,
  db: Db,
  email: string,
  password: string,
  name: string,
  inviteCode: string,
): Promise<{ verifyToken: string }> {
  const res = await app.request("/api/auth/signup", {
    method: "POST",
    body: signupBody({ email, password, name, inviteCode }),
    headers: JSON_HEADERS,
  });
  expect(res.status).toBe(202);
  const outbox = mockMail.outbox();
  const html = outbox[0]?.html ?? "";
  const verifyToken = extractToken(html);
  const vres = await app.request("/api/auth/verify", {
    method: "POST",
    body: JSON.stringify({ token: verifyToken }),
    headers: JSON_HEADERS,
  });
  expect(vres.status).toBe(200);
  return { verifyToken };
}

describe("sign-up + verify + resend", () => {
  beforeEach(() => {
    mockMail.clear();
  });

  // FR-1..FR-3: valid invite + email + password + name → 202 verify_email_sent
  it("valid invite + email + password + name → 202 verify_email_sent, unverified user, verification email queued", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const mail = mailForTest();
      const app = authRoutes(db, mail);
      const email = "ada@example.com";
      const code = await mintInvite(db);

      const res = await app.request("/api/auth/signup", {
        method: "POST",
        body: signupBody({
          email,
          password: "supersecret-1",
          name: "Ada",
          inviteCode: code,
        }),
        headers: JSON_HEADERS,
      });

      expect(res.status).toBe(202);
      const body = (await res.json()) as ErrorBody;
      expect(body.status).toBe("verify_email_sent");

      const users =
        await db.query`SELECT email_verified_at FROM users WHERE email = ${email}`;
      expect(users[0]?.email_verified_at).toBeNull();

      const outbox = mockMail.outbox();
      expect(outbox).toHaveLength(1);
      expect(outbox[0]?.html).toContain("/verify?token=");
    } finally {
      await close();
    }
  });

  // FR-2: missing invite code → 403 bad_invite; invites table unaffected.
  it("missing invite code → 403 bad_invite", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const mail = mailForTest();
      const app = authRoutes(db, mail);
      const before = await db.query`SELECT count(*)::int AS n FROM invites`;

      const res = await app.request("/api/auth/signup", {
        method: "POST",
        body: signupBody({
          email: "x@example.com",
          password: "supersecret-1",
          name: "X",
          inviteCode: "NOTREAL",
        }),
        headers: JSON_HEADERS,
      });

      expect(res.status).toBe(403);
      const body = (await res.json()) as ErrorBody;
      expect(body.code).toBe("bad_invite");

      const after = await db.query`SELECT count(*)::int AS n FROM invites`;
      expect(after).toEqual(before);
    } finally {
      await close();
    }
  });

  // FR-2: expired invite → 403 bad_invite.
  it("expired invite → 403 bad_invite", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const mail = mailForTest();
      const app = authRoutes(db, mail);
      const code = await mintInvite(db, {
        expiresAt: new Date(Date.now() - 1000),
      });

      const res = await app.request("/api/auth/signup", {
        method: "POST",
        body: signupBody({
          email: "exp@example.com",
          password: "supersecret-1",
          name: "Exp",
          inviteCode: code,
        }),
        headers: JSON_HEADERS,
      });

      expect(res.status).toBe(403);
      const body = (await res.json()) as ErrorBody;
      expect(body.code).toBe("bad_invite");
    } finally {
      await close();
    }
  });

  // FR-3: the invite is NOT consumed until the account verifies.
  it("invite is NOT consumed until the account verifies", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const mail = mailForTest();
      const app = authRoutes(db, mail);
      const code = await mintInvite(db);
      const codeHash = hashToken(code);

      const res = await app.request("/api/auth/signup", {
        method: "POST",
        body: signupBody({
          email: "ada@example.com",
          password: "supersecret-1",
          name: "Ada",
          inviteCode: code,
        }),
        headers: JSON_HEADERS,
      });
      expect(res.status).toBe(202);

      const rows =
        await db.query`SELECT consumed_at FROM invites WHERE code_hash = ${codeHash}`;
      expect(rows[0]?.consumed_at).toBeNull();
    } finally {
      await close();
    }
  });

  // FR-4: re-signup with the same unverified email rotates the verify token
  // (old ones consumed) and rotates the password; a second email is queued.
  it("re-signup with the same unverified email re-issues a fresh token and rotates password", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const mail = mailForTest();
      const app = authRoutes(db, mail);
      const email = "dup@example.com";
      const code = await mintInvite(db);

      const r1 = await app.request("/api/auth/signup", {
        method: "POST",
        body: signupBody({
          email,
          password: "first-pw-123",
          name: "First",
          inviteCode: code,
        }),
        headers: JSON_HEADERS,
      });
      expect(r1.status).toBe(202);
      expect(mockMail.outbox()).toHaveLength(1);

      const r2 = await app.request("/api/auth/signup", {
        method: "POST",
        body: signupBody({
          email,
          password: "second-pw-234",
          name: "Second",
          inviteCode: code,
        }),
        headers: JSON_HEADERS,
      });
      expect(r2.status).toBe(202);
      expect(mockMail.outbox()).toHaveLength(2);

      const userId = await userIdByEmail(db, email);
      const outstanding =
        await db.query`SELECT count(*)::int AS n FROM auth_tokens WHERE user_id = ${userId} AND kind = 'verify_email' AND consumed_at IS NULL`;
      expect(outstanding).toEqual([{ n: 1 }]);
    } finally {
      await close();
    }
  });

  // FR-5: re-signup with an already-verified email → 409 email_taken.
  it("re-signup with a verified email → 409 email_taken", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const mail = mailForTest();
      const app = authRoutes(db, mail);
      const email = "taken@example.com";
      const code = await mintInvite(db);

      await fullSignupAndVerify(app, db, email, "verified-pw-1", "First", code);

      const res = await app.request("/api/auth/signup", {
        method: "POST",
        body: signupBody({
          email,
          password: "verified-pw-2",
          name: "Second",
          // A fresh invite code is fine here — the email check is what 409s.
          inviteCode: await mintInvite(db),
        }),
        headers: JSON_HEADERS,
      });

      expect(res.status).toBe(409);
      const body = (await res.json()) as ErrorBody;
      expect(body.code).toBe("email_taken");
    } finally {
      await close();
    }
  });

  // FR-3..FR-6: verify a valid token → 200 { user }, sets session cookie,
  // marks the user verified, and consumes both the token and its invite.
  it("verify with a valid token → 200 { user }, sets cookie, marks verified, consumes token + invite", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const mail = mailForTest();
      const app = authRoutes(db, mail);
      const email = "ada@example.com";
      const code = await mintInvite(db);
      const codeHash = hashToken(code);

      const sres = await app.request("/api/auth/signup", {
        method: "POST",
        body: signupBody({
          email,
          password: "supersecret-1",
          name: "Ada",
          inviteCode: code,
        }),
        headers: JSON_HEADERS,
      });
      expect(sres.status).toBe(202);

      const token = extractToken(mockMail.outbox()[0]?.html ?? "");
      const vres = await app.request("/api/auth/verify", {
        method: "POST",
        body: JSON.stringify({ token }),
        headers: JSON_HEADERS,
      });

      expect(vres.status).toBe(200);
      const vbody = (await vres.json()) as VerifyBody;
      expect(vbody.user.email).toBe(email);
      expect(vbody.user.name).toBe("Ada");

      const setCookie = vres.headers.get("set-cookie");
      expect(setCookie).toContain("pigeon_session=");

      const users =
        await db.query`SELECT email_verified_at FROM users WHERE email = ${email}`;
      expect(users[0]?.email_verified_at).not.toBeNull();

      const tokenHash = hashToken(token);
      const tokRows =
        await db.query`SELECT consumed_at FROM auth_tokens WHERE token_hash = ${tokenHash}`;
      expect(tokRows[0]?.consumed_at).not.toBeNull();

      const invRows =
        await db.query`SELECT consumed_at FROM invites WHERE code_hash = ${codeHash}`;
      expect(invRows[0]?.consumed_at).not.toBeNull();
    } finally {
      await close();
    }
  });

  // FR-6: verify tokens are single-use.
  it("verify token is single-use", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const mail = mailForTest();
      const app = authRoutes(db, mail);
      const email = "ada@example.com";
      const code = await mintInvite(db);

      const sres = await app.request("/api/auth/signup", {
        method: "POST",
        body: signupBody({
          email,
          password: "supersecret-1",
          name: "Ada",
          inviteCode: code,
        }),
        headers: JSON_HEADERS,
      });
      expect(sres.status).toBe(202);

      const token = extractToken(mockMail.outbox()[0]?.html ?? "");
      const v1 = await app.request("/api/auth/verify", {
        method: "POST",
        body: JSON.stringify({ token }),
        headers: JSON_HEADERS,
      });
      expect(v1.status).toBe(200);

      // Second use of the same token must be rejected as invalid/expired.
      const v2 = await app.request("/api/auth/verify", {
        method: "POST",
        body: JSON.stringify({ token }),
        headers: JSON_HEADERS,
      });
      expect(v2.status).toBe(400);
      const body = (await v2.json()) as ErrorBody;
      expect(body.code).toBe("invalid_or_expired_token");
    } finally {
      await close();
    }
  });

  // FR-7 / FR-9: resend mints a fresh token (outbox grows) but observes the
  // 60s cooldown (no fresh token, no new email).
  it("resend for an unverified user → 202 and a new token; within cooldown → 202 but no new token", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const mail = mailForTest();
      const app = authRoutes(db, mail);
      const email = "ada@example.com";
      const code = await mintInvite(db);

      const sres = await app.request("/api/auth/signup", {
        method: "POST",
        body: signupBody({
          email,
          password: "supersecret-1",
          name: "Ada",
          inviteCode: code,
        }),
        headers: JSON_HEADERS,
      });
      expect(sres.status).toBe(202);
      expect(mockMail.outbox()).toHaveLength(1);

      const r1 = await app.request("/api/auth/verify/resend", {
        method: "POST",
        body: JSON.stringify({ email }),
        headers: JSON_HEADERS,
      });
      expect(r1.status).toBe(202);
      expect(mockMail.outbox()).toHaveLength(2);

      // Second resend within the cooldown window must still 202 (no
      // enumeration) but must NOT mint a fresh token / send another email.
      const r2 = await app.request("/api/auth/verify/resend", {
        method: "POST",
        body: JSON.stringify({ email }),
        headers: JSON_HEADERS,
      });
      expect(r2.status).toBe(202);
      expect(mockMail.outbox()).toHaveLength(2);
    } finally {
      await close();
    }
  });

  // FR-9: resend for an unknown address returns 202 (no enumeration) and
  // sends nothing.
  it("resend for a nonexistent email → 202 (no enumeration)", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const mail = mailForTest();
      const app = authRoutes(db, mail);

      const res = await app.request("/api/auth/verify/resend", {
        method: "POST",
        body: JSON.stringify({ email: "nope@nope.com" }),
        headers: JSON_HEADERS,
      });

      expect(res.status).toBe(202);
      expect(mockMail.outbox()).toHaveLength(0);
    } finally {
      await close();
    }
  });

  // FR-1: name is required at sign-up (empty or whitespace-only rejected).
  it("name is required at signup", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const mail = mailForTest();
      const app = authRoutes(db, mail);
      const code = await mintInvite(db);

      const empty = await app.request("/api/auth/signup", {
        method: "POST",
        body: signupBody({
          email: "a@example.com",
          password: "supersecret-1",
          name: "",
          inviteCode: code,
        }),
        headers: JSON_HEADERS,
      });
      expect(empty.status).toBe(400);

      const ws = await app.request("/api/auth/signup", {
        method: "POST",
        body: signupBody({
          email: "b@example.com",
          password: "supersecret-1",
          name: "   ",
          inviteCode: code,
        }),
        headers: JSON_HEADERS,
      });
      expect(ws.status).toBe(400);
    } finally {
      await close();
    }
  });
});

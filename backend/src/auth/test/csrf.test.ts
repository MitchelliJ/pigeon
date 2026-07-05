/**
 * Integration tests for the CSRF (Origin/Referer) guard on mutating auth
 * routes (Authentication & User Accounts PRD §3.4 FR-33, FR-34; AC-9).
 *
 * Same harness as `signup-verify.test.ts` / `sessions-login.test.ts`: boot an
 * embedded Postgres cluster via `withTestDb`, run migrations, mount the auth
 * router as `app = authRoutes(db, mail)`, and drive it through Hono's
 * in-process `app.request` API.
 *
 * Scope: ONLY the cross-origin rejection boundary itself, exercised against
 * `POST /api/auth/login` (the PRD's example mutating route). This file does
 * NOT test login's own auth logic (bad password, unverified user, etc.) —
 * that's `sessions-login.test.ts`'s job. The login body used here is a
 * syntactically-valid but bogus credential pair; whether the guard is in
 * front of the route, the point under test is only whether the request is
 * rejected as cross-origin BEFORE login logic runs.
 *
 * RED note: at authoring time neither the CSRF guard nor `POST
 * /api/auth/login` exist on the router `authRoutes` returns. Every request
 * below to `/api/auth/login` currently 404s (Hono's default not-found
 * handler), so:
 *   - Case 1 (cross-origin `Origin`) expects 403 `{ code: "cross_origin" }`
 *     but will actually see 404 with a body that has no `code: "cross_origin"`.
 *   - Cases 2-4 (same-origin / referer-only / neither header) only assert
 *     "not blocked as cross-origin" (`status !== 403` and/or `code !==
 *     "cross_origin"`), so a 404 currently satisfies those assertions -- they
 *     will pass today for the wrong reason (route doesn't exist), then
 *     legitimately continue to pass once login + the guard both land. Case 1
 *     is the only one that's guaranteed RED right now.
 */
import { describe, it, expect } from "vitest";
import { withTestDb } from "../../../test/db";
import { runMigrations } from "../../migrate/runner";
import { authRoutes } from "../routes";
import { createMailSender } from "../../mail/index";

const ORIGIN = "http://localhost:4321";

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

/** Any syntactically-valid login body -- its actual credentials don't matter
 * here since the CSRF guard should reject before login logic ever runs. */
const BOGUS_LOGIN_BODY = JSON.stringify({
  email: "nobody@example.com",
  password: "irrelevant-1",
});

describe("CSRF guard on mutating auth routes", () => {
  // FR-33/FR-34, AC-9: an Origin that does not match APP_BASE_URL's host is
  // rejected before the route's own logic runs.
  it("POST /api/auth/login with a cross-origin Origin header returns 403 cross_origin", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const app = authRoutes(db, mailForTest());

      const res = await app.request("/api/auth/login", {
        method: "POST",
        body: BOGUS_LOGIN_BODY,
        headers: {
          "content-type": "application/json",
          origin: "https://evil.test",
        },
      });

      expect(res.status).toBe(403);
      const body = (await res.json()) as ErrorBody;
      expect(body.code).toBe("cross_origin");
    } finally {
      await close();
    }
  });

  // FR-33/FR-34: an Origin that matches APP_BASE_URL's host exactly must NOT
  // be blocked by the CSRF guard -- the request proceeds to login's own
  // logic (bogus credentials here, so whatever status that logic returns is
  // fine; only the CSRF rejection itself is out of bounds).
  it("POST /api/auth/login with a same-origin Origin header is not blocked by the CSRF guard", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const app = authRoutes(db, mailForTest());

      const res = await app.request("/api/auth/login", {
        method: "POST",
        body: BOGUS_LOGIN_BODY,
        headers: { "content-type": "application/json", origin: ORIGIN },
      });

      expect(res.status).not.toBe(403);
      const body = (await res.json()) as ErrorBody;
      expect(body.code).not.toBe("cross_origin");
    } finally {
      await close();
    }
  });

  // FR-33/FR-34: when Origin is absent, a same-host Referer is consulted
  // instead, and must likewise not be blocked.
  it("POST /api/auth/login with no Origin but a same-host Referer is not blocked by the CSRF guard", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const app = authRoutes(db, mailForTest());

      const res = await app.request("/api/auth/login", {
        method: "POST",
        body: BOGUS_LOGIN_BODY,
        headers: {
          "content-type": "application/json",
          referer: `${ORIGIN}/login`,
        },
      });

      expect(res.status).not.toBe(403);
      const body = (await res.json()) as ErrorBody;
      expect(body.code).not.toBe("cross_origin");
    } finally {
      await close();
    }
  });

  // FR-33/FR-34: with NEITHER Origin NOR Referer present, the request must
  // still proceed -- the SameSite=Lax cookie + non-GET method is the real
  // guard here; the Origin/Referer check is defense-in-depth only and must
  // not reject a request that simply lacks both headers.
  it("POST /api/auth/login with neither Origin nor Referer is not blocked by the CSRF guard", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const app = authRoutes(db, mailForTest());

      const res = await app.request("/api/auth/login", {
        method: "POST",
        body: BOGUS_LOGIN_BODY,
        headers: { "content-type": "application/json" },
      });

      expect(res.status).not.toBe(403);
      const body = (await res.json()) as ErrorBody;
      expect(body.code).not.toBe("cross_origin");
    } finally {
      await close();
    }
  });
});

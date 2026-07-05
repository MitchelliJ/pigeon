/*
 * Auth HTTP routes (Authentication & User Accounts PRD).
 *
 * `authRoutes(db, mail)` mounts the full auth surface — sign-up,
 * verify-email, resend, login, password-reset (request + confirm), `/me`,
 * and logout — on their own Hono app so `server.ts` can compose it alongside
 * the liveness/readiness routes. Every error response uses the same
 * `{ error, code }` envelope (PRD §3.2). Handlers stay thin: parse/validate
 * the request, delegate to `./service` or `./middleware`, then shape the HTTP
 * response from the result `kind`. Every mutating route runs behind
 * `csrfGuard`; `/me` and `/logout` also run behind `requireAuth`, which
 * attaches the caller's `SessionUser` to the context — the other mutating
 * routes (sign-up, verify, login, resend, and both password-reset routes)
 * don't require a session, since each is either how a session gets started or
 * (for password-reset confirm) authenticated by the reset token itself
 * instead.
 *
 * `APP_BASE_URL` (used to build the verify-email link and as `csrfGuard`'s
 * trusted origin) is read straight from `process.env` rather than via
 * `parseConfig`, because `parseConfig` requires `DATABASE_URL` in the `test`
 * NODE_ENV and this router is handed an already-built `db` — it must not
 * re-validate the whole process environment just to learn one URL. It shares
 * the same "http://localhost:4321" fallback as `parseConfig` in
 * non-production environments.
 */
import { Hono } from "hono";
import {
  login,
  requestReset,
  resendVerify,
  resetPassword,
  resetSchema,
  revokeSession,
  signup,
  signupSchema,
  verify,
} from "./service";
import { csrfGuard, requireAuth } from "./middleware";
import type { Context } from "hono";
import type { AuthVariables } from "./middleware";
import type { Db } from "../db/index";
import type { MailSender } from "../mail/index";

const DEFAULT_APP_BASE_URL = "http://localhost:4321";

/** Clear the session cookie a login/verify previously set (FR-19: logout). */
const CLEAR_SESSION_COOKIE =
  "pigeon_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0";

/**
 * Build the `Set-Cookie` value that starts a session, shared by login's and
 * verify's success paths (both mint a session the same way).
 *
 * FR-17: no `Secure` flag yet — this feature runs in dev/test only so far. A
 * later slice makes it conditional on NODE_ENV==='production'.
 */
function sessionCookie(sessionToken: string): string {
  return `pigeon_session=${sessionToken}; HttpOnly; SameSite=Lax; Path=/`;
}

/**
 * Parse a request's JSON body, returning `undefined` when it isn't valid
 * JSON. `undefined` is safe as an "invalid" sentinel because `JSON.parse`
 * (and therefore `c.req.json()`) can never produce it — a literal JSON
 * `null` body still comes back as `null`, not `undefined`.
 */
async function readJsonBody(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return undefined;
  }
}

/** Mount the auth routes onto a fresh Hono app bound to `db` and `mail`. */
export function authRoutes(
  db: Db,
  mail: MailSender,
): Hono<{ Variables: AuthVariables }> {
  const app = new Hono<{ Variables: AuthVariables }>();
  const appBaseUrl = process.env.APP_BASE_URL ?? DEFAULT_APP_BASE_URL;
  // FR-33/FR-34, AC-9: reject cross-origin requests before any route logic
  // (including requireAuth on /logout) runs.
  const csrf = csrfGuard(appBaseUrl);

  app.post("/api/auth/signup", csrf, async (c) => {
    const body = await readJsonBody(c);
    if (body === undefined) {
      return c.json(
        { error: "request body must be JSON", code: "invalid_body" },
        400,
      );
    }

    const parsed = signupSchema.safeParse(body);
    if (!parsed.success) {
      const message =
        parsed.error.issues[0]?.message ?? "invalid sign-up request";
      return c.json({ error: message, code: "invalid_input" }, 400);
    }

    const result = await signup(
      db,
      mail,
      { APP_BASE_URL: appBaseUrl },
      parsed.data,
    );
    switch (result.kind) {
      case "verify_email_sent":
        return c.json({ status: "verify_email_sent" }, 202);
      case "bad_invite":
        return c.json(
          {
            error: "invite code is invalid, expired, or already used",
            code: "bad_invite",
          },
          403,
        );
      case "email_taken":
        return c.json(
          { error: "email already registered", code: "email_taken" },
          409,
        );
    }
  });

  app.post("/api/auth/verify", csrf, async (c) => {
    const body = await readJsonBody(c);
    if (body === undefined) {
      return c.json(
        { error: "request body must be JSON", code: "invalid_body" },
        400,
      );
    }

    const token = (body as { token?: unknown } | null)?.token;
    if (typeof token !== "string" || token.length === 0) {
      return c.json({ error: "token is required", code: "invalid_input" }, 400);
    }

    const result = await verify(db, mail, token);
    switch (result.kind) {
      case "verified":
        c.header("Set-Cookie", sessionCookie(result.sessionToken));
        return c.json({ user: result.user }, 200);
      case "invalid_or_expired_token":
        return c.json(
          {
            error: "verification link is invalid or expired",
            code: "invalid_or_expired_token",
          },
          400,
        );
    }
  });

  app.post("/api/auth/login", csrf, async (c) => {
    const body = await readJsonBody(c);
    if (body === undefined) {
      return c.json(
        { error: "request body must be JSON", code: "invalid_body" },
        400,
      );
    }

    const loginBody = body as { email?: unknown; password?: unknown } | null;
    const email = loginBody?.email;
    const password = loginBody?.password;
    if (
      typeof email !== "string" ||
      email.length === 0 ||
      typeof password !== "string" ||
      password.length === 0
    ) {
      return c.json(
        { error: "email and password are required", code: "invalid_input" },
        400,
      );
    }

    const result = await login(db, email, password);
    switch (result.kind) {
      case "logged_in":
        c.header("Set-Cookie", sessionCookie(result.sessionToken));
        return c.json({ user: result.user }, 200);
      case "bad_credentials":
        return c.json(
          { error: "email or password is incorrect", code: "bad_credentials" },
          401,
        );
    }
  });

  app.post("/api/auth/verify/resend", csrf, async (c) => {
    const body = await readJsonBody(c);
    if (body === undefined) {
      return c.json(
        { error: "request body must be JSON", code: "invalid_body" },
        400,
      );
    }

    const email = (body as { email?: unknown } | null)?.email;
    if (typeof email !== "string" || email.length === 0) {
      return c.json({ error: "email is required", code: "invalid_input" }, 400);
    }

    // FR-9: always 202, regardless of whether the address exists, is already
    // verified, or is within the resend cooldown — no user enumeration.
    await resendVerify(db, mail, { APP_BASE_URL: appBaseUrl }, email);
    return c.json({ status: "ok" }, 202);
  });

  app.post("/api/auth/password/reset-request", csrf, async (c) => {
    const body = await readJsonBody(c);
    if (body === undefined) {
      return c.json(
        { error: "request body must be JSON", code: "invalid_body" },
        400,
      );
    }

    const email = (body as { email?: unknown } | null)?.email;
    if (typeof email !== "string" || email.length === 0) {
      return c.json({ error: "email is required", code: "invalid_input" }, 400);
    }

    // FR-22: always 202, regardless of whether the address exists or is
    // within the reset-request cooldown — no user enumeration.
    await requestReset(db, mail, { APP_BASE_URL: appBaseUrl }, email);
    return c.json({ status: "ok" }, 202);
  });

  // FR-23: confirm a password reset. No `requireAuth` — the reset token
  // itself is the credential; the caller isn't logged in yet.
  app.post("/api/auth/password/reset", csrf, async (c) => {
    const body = await readJsonBody(c);
    if (body === undefined) {
      return c.json(
        { error: "request body must be JSON", code: "invalid_body" },
        400,
      );
    }

    const parsed = resetSchema.safeParse(body);
    if (!parsed.success) {
      const message =
        parsed.error.issues[0]?.message ?? "invalid reset request";
      return c.json({ error: message, code: "invalid_input" }, 400);
    }

    const result = await resetPassword(
      db,
      parsed.data.token,
      parsed.data.newPassword,
    );
    switch (result.kind) {
      case "reset":
        return c.json({ ok: true }, 200);
      case "invalid_or_expired_token":
        return c.json(
          {
            error: "reset link is invalid or expired",
            code: "invalid_or_expired_token",
          },
          400,
        );
    }
  });

  // FR-17/FR-18: return the caller's own SessionUser, as attached by requireAuth.
  app.get("/api/auth/me", requireAuth(db), (c) => {
    return c.json({ user: c.get("sessionUser") }, 200);
  });

  // FR-19: revoke the current session and clear its cookie.
  app.post("/api/auth/logout", csrf, requireAuth(db), async (c) => {
    await revokeSession(db, c.get("sessionTokenHash"));
    c.header("Set-Cookie", CLEAR_SESSION_COOKIE);
    return c.json({ ok: true }, 200);
  });

  return app;
}

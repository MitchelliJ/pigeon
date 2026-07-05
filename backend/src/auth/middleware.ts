/*
 * Auth middleware: `requireAuth` and `csrfGuard` (Authentication & User
 * Accounts PRD FR-16..FR-19 and FR-33/FR-34).
 *
 * `requireAuth` guards authenticated-only routes. What: reads the
 * `pigeon_session` cookie, hashes it, and looks up a live session (not
 * revoked, not expired, not past either the sliding 30-day idle cap or the
 * absolute 90-day cap) joined to its owning user. On success it renews the
 * session (FR-18: `last_seen_at = now()`, `expires_at` recomputed), attaches
 * the resulting `SessionUser` plus the session's `token_hash` to Hono's
 * context so downstream handlers (`/me`, `/logout`) can read them without
 * repeating the lookup, then calls `next()`. A missing cookie and a cookie
 * with no matching live session both respond identically — 401
 * `{ error, code: "unauthenticated" }` — so a caller can't tell which
 * happened.
 *
 * Why the admission check re-derives the caps from `created_at`/`last_seen_at`
 * instead of trusting the stored `expires_at` alone: `expires_at` is a cached
 * `min(created_at + 90d, now_at_last_renewal + 30d)` value that's only ever
 * updated by a renewal write. Between renewals it can lag behind what the two
 * caps would say right now, so admission independently checks
 * `created_at + 90d > now()` and `last_seen_at + 30d > now()` alongside the
 * cached `expires_at > now()`, and the renewal write below keeps `expires_at`
 * in sync afterwards.
 *
 * `csrfGuard` is the separate defense-in-depth CSRF check mounted ahead of
 * every mutating auth route in `./routes` — see its own doc comment below for
 * how it works.
 */
import { getCookie } from "hono/cookie";
import { hashToken } from "./tokens";
import type { Context, MiddlewareHandler } from "hono";
import type { Db } from "../db/index";
import type { SessionUser } from "@pigeon/shared";

/** Name of the httpOnly session cookie set by login/verify. */
export const SESSION_COOKIE_NAME = "pigeon_session";

/** Context variables `requireAuth` attaches for downstream handlers. */
export interface AuthVariables {
  sessionUser: SessionUser;
  /** sha256 hash of the session token that authenticated this request. */
  sessionTokenHash: string;
}

/**
 * Look up a live session by its token hash, joined to the owning user, and —
 * on a hit — renew it (FR-18). "Live" means not revoked and within all three
 * of: the cached `expires_at`, the sliding 30-day idle window measured from
 * `last_seen_at`, and the absolute 90-day cap measured from `created_at`. The
 * renewal write refreshes `last_seen_at` to now and recomputes `expires_at` as
 * `min(created_at + 90d, now() + 30d)` from the row's real `created_at`, so a
 * stale cached `expires_at` never outlives what the two authoritative caps
 * would allow. Returns `undefined` when no such live session exists.
 */
async function loadSessionUser(
  db: Db,
  tokenHash: string,
): Promise<SessionUser | undefined> {
  const rows = await db.query`
    SELECT sessions.id AS session_id, users.id, users.email, users.name, users.tier
    FROM sessions
    JOIN users ON users.id = sessions.user_id
    WHERE sessions.token_hash = ${tokenHash}
      AND sessions.revoked_at IS NULL
      AND sessions.expires_at > now()
      AND sessions.created_at + interval '90 days' > now()
      AND sessions.last_seen_at + interval '30 days' > now()
  `;
  const row = rows[0];
  if (!row) {
    return undefined;
  }

  await db.query`
    UPDATE sessions
    SET last_seen_at = now(),
        expires_at = LEAST(created_at + interval '90 days', now() + interval '30 days')
    WHERE id = ${row.session_id}
  `;

  return {
    id: String(row.id),
    email: String(row.email),
    name: String(row.name),
    tier: String(row.tier),
  };
}

/** The identical 401 both "no cookie" and "no matching session" produce. */
function unauthenticated(c: Context): Response {
  return c.json(
    { error: "authentication required", code: "unauthenticated" },
    401,
  );
}

/** Build the `requireAuth` middleware bound to `db`. */
export function requireAuth(
  db: Db,
): MiddlewareHandler<{ Variables: AuthVariables }> {
  return async (c, next) => {
    const token = getCookie(c, SESSION_COOKIE_NAME);
    if (!token) {
      return unauthenticated(c);
    }

    const tokenHash = hashToken(token);
    const sessionUser = await loadSessionUser(db, tokenHash);
    if (!sessionUser) {
      return unauthenticated(c);
    }

    c.set("sessionUser", sessionUser);
    c.set("sessionTokenHash", tokenHash);
    await next();
  };
}

/**
 * `csrfGuard` — defense-in-depth CSRF check for mutating auth routes
 * (Authentication & User Accounts PRD §3.4 FR-33, FR-34; AC-9).
 *
 * The real CSRF guard is the session cookie's `SameSite=Lax` attribute plus
 * these routes all being non-GET, which browsers already refuse to attach
 * cross-site. This middleware is a second line of defense: it reads the
 * `Origin` header (falling back to `Referer` when `Origin` is absent) and
 * rejects the request unless its host matches `appBaseUrl`'s host.
 *
 * A request with NEITHER header is allowed through unconditionally — that's
 * the normal shape of a same-origin fetch from most browsers, and the
 * SameSite cookie already covers the cross-site case. A header that IS
 * present but doesn't parse as a URL, or whose host doesn't match, is
 * rejected (fail closed) rather than silently ignored.
 */
export function csrfGuard(appBaseUrl: string): MiddlewareHandler {
  const trustedHost = new URL(appBaseUrl).host;

  /** `undefined` = no such header; `null` = present but unparseable. */
  const hostOf = (
    headerValue: string | undefined,
  ): string | undefined | null => {
    if (headerValue === undefined) {
      return undefined;
    }
    try {
      return new URL(headerValue).host;
    } catch {
      return null;
    }
  };

  return async (c, next) => {
    const origin = c.req.header("origin");
    const referer = c.req.header("referer");
    const host = origin !== undefined ? hostOf(origin) : hostOf(referer);

    if (host !== undefined && host !== trustedHost) {
      return c.json(
        { error: "cross-origin request rejected", code: "cross_origin" },
        403,
      );
    }

    await next();
  };
}

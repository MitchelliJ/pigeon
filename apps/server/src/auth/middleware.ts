/** Session-cookie auth middleware. */
import type { Context, Next } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { AppEnv } from "../app.js";
import { getSessionUser } from "./service.js";

export const SESSION_COOKIE = "pigeon_session";

export function sessionCookieOptions(secure: boolean) {
  return {
    httpOnly: true,
    secure,
    sameSite: "Lax" as const,
    path: "/",
    maxAge: 30 * 24 * 60 * 60,
  };
}

export function setSessionCookie(c: Context<AppEnv>, token: string) {
  const { config } = c.get("deps");
  setCookie(c, SESSION_COOKIE, token, sessionCookieOptions(config.NODE_ENV === "production"));
}

export function clearSessionCookie(c: Context<AppEnv>) {
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
}

/** Rejects with 401 unless a valid session cookie is present; sets `user`. */
export async function requireAuth(c: Context<AppEnv>, next: Next) {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return c.json({ error: "authentication required" }, 401);
  const { pool } = c.get("deps");
  const user = await getSessionUser(pool, token);
  if (!user) {
    clearSessionCookie(c);
    return c.json({ error: "session expired" }, 401);
  }
  c.set("user", user);
  await next();
}

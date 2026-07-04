/** /api/auth — signup, login, logout, current user. */
import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { z } from "zod";
import { audit } from "@pigeon/db";
import type { AppEnv } from "../app.js";
import {
  clearSessionCookie,
  requireAuth,
  SESSION_COOKIE,
  setSessionCookie,
} from "./middleware.js";
import {
  createSession,
  createUser,
  deleteSession,
  EmailTakenError,
  verifyLogin,
} from "./service.js";

const credentialsSchema = z.object({
  email: z.string().email().max(320),
  password: z.string().min(8).max(1024),
  name: z.string().max(200).optional(),
});

export const authRoutes = new Hono<AppEnv>()
  .post("/signup", async (c) => {
    const body = credentialsSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) {
      return c.json({ error: body.error.issues[0]?.message ?? "invalid input" }, 400);
    }
    const { pool } = c.get("deps");
    try {
      const user = await createUser(pool, body.data);
      // Signing up IS accepting terms + privacy policy (stated on the form);
      // record both consents with the current version.
      await pool.query(
        `INSERT INTO consents (user_id, kind, version, granted)
         VALUES ($1, 'terms', 'v1', true), ($1, 'privacy', 'v1', true)`,
        [user.id],
      );
      await audit(pool, { userId: user.id, actor: "user", action: "auth.signup" });
      const token = await createSession(pool, user.id);
      setSessionCookie(c, token);
      return c.json({ user }, 201);
    } catch (err) {
      if (err instanceof EmailTakenError) {
        return c.json({ error: err.message }, 409);
      }
      throw err;
    }
  })
  .post("/login", async (c) => {
    const body = credentialsSchema
      .pick({ email: true, password: true })
      .safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) {
      return c.json({ error: "invalid input" }, 400);
    }
    const { pool } = c.get("deps");
    const user = await verifyLogin(pool, body.data.email, body.data.password);
    if (!user) return c.json({ error: "invalid email or password" }, 401);
    await audit(pool, { userId: user.id, actor: "user", action: "auth.login" });
    const token = await createSession(pool, user.id);
    setSessionCookie(c, token);
    return c.json({ user });
  })
  .post("/logout", async (c) => {
    const token = getCookie(c, SESSION_COOKIE);
    if (token) {
      await deleteSession(c.get("deps").pool, token);
    }
    clearSessionCookie(c);
    return c.json({ ok: true });
  })
  .get("/me", requireAuth, (c) => c.json({ user: c.get("user") }));

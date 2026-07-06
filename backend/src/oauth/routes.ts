/*
 * OAuth provider discovery route (Inbox Connectors & Provider Abstraction PRD
 * §3.2.6, FR-11).
 *
 * `oauthRoutes(db)` mounts `GET /api/oauth/providers` behind `requireAuth(db)`
 * for consistency with every other Feature-3-and-later route, even though the
 * connect dialog that calls it only requires the caller to already be
 * authenticated (a mailbox need not exist yet).
 *
 * This is a **trivial stub**: it always responds `200 { providers: [] }`, so
 * the frontend connect dialog has an empty list to render and no OAuth
 * provider is offered. Feature 11 (OAuth provider connectors) replaces this
 * body with real Google/Microsoft OAuth app discovery. `GET /api/oauth/:id/
 * start` is deliberately not implemented yet — it remains a 404 until
 * Feature 11 lands.
 */
import { Hono } from "hono";
import { requireAuth } from "../auth/middleware";
import type { AuthVariables } from "../auth/middleware";
import type { Db } from "../db/index";

/** Mount `GET /api/oauth/providers` onto a fresh Hono app bound to `db`. */
export function oauthRoutes(db: Db): Hono<{ Variables: AuthVariables }> {
  const app = new Hono<{ Variables: AuthVariables }>();

  app.get("/api/oauth/providers", requireAuth(db), (c) => {
    return c.json({ providers: [] }, 200);
  });

  return app;
}

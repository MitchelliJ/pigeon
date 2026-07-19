/* Authenticated profile settings routes. */
import { Hono } from "hono";
import { z } from "zod";

import { csrfGuard, requireAuth } from "../auth/middleware";
import { bodyLimit } from "../http/limits";
import type { Context } from "hono";
import type { AuthVariables } from "../auth/middleware";
import type { Db } from "../db/index";

const MAX_BODY_BYTES = 64 * 1024;
const DEFAULT_APP_BASE_URL = "http://localhost:4321";

const profilePatchSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
  })
  .strict();

async function readJsonBody(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return undefined;
  }
}

function profileFromRow(row: {
  name?: unknown;
  email?: unknown;
  tier?: unknown;
}): {
  name: string;
  email: string;
  tier: string;
} {
  return {
    name: String(row.name),
    email: String(row.email),
    tier: String(row.tier),
  };
}

/** Build the authenticated profile settings router. */
export function profileRoutes(db: Db): Hono<{ Variables: AuthVariables }> {
  const app = new Hono<{ Variables: AuthVariables }>();
  const auth = requireAuth(db);
  const csrf = csrfGuard(process.env.APP_BASE_URL ?? DEFAULT_APP_BASE_URL);

  app.get("/api/settings/profile", auth, (c) => {
    return c.json({ profile: profileFromRow(c.get("sessionUser")) }, 200);
  });

  app.patch(
    "/api/settings/profile",
    bodyLimit(MAX_BODY_BYTES),
    csrf,
    auth,
    async (c) => {
      const body = await readJsonBody(c);
      if (body === undefined) {
        return c.json(
          { error: "request body must be JSON", code: "invalid_body" },
          400,
        );
      }

      const parsed = profilePatchSchema.safeParse(body);
      if (!parsed.success) {
        return c.json(
          {
            error: "name must be between 1 and 100 characters",
            code: "invalid_input",
          },
          400,
        );
      }

      const rows = await db.query`
        UPDATE users
        SET name = ${parsed.data.name}, updated_at = now()
        WHERE id = ${c.get("sessionUser").id}
        RETURNING name, email, tier
      `;
      const row = rows[0];
      if (!row) {
        return c.json({ error: "profile not found", code: "not_found" }, 404);
      }

      return c.json({ profile: profileFromRow(row) }, 200);
    },
  );

  return app;
}

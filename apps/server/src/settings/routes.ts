/** /api/settings/profile — name + custom AI triage instructions. */
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../app.js";
import { requireAuth } from "../auth/middleware.js";

const patchSchema = z.object({
  name: z.string().max(200).optional(),
  llmInstructions: z.string().max(4000).optional(),
});

export const profileRoutes = new Hono<AppEnv>()
  .use("*", requireAuth)

  .get("/", async (c) => {
    const { pool } = c.get("deps");
    const user = c.get("user");
    const { rows } = await pool.query(
      "SELECT name, email, tier, llm_instructions FROM users WHERE id = $1",
      [user.id],
    );
    return c.json({
      profile: {
        name: rows[0].name,
        email: rows[0].email,
        tier: rows[0].tier,
        llmInstructions: rows[0].llm_instructions,
      },
    });
  })

  .patch("/", async (c) => {
    const body = patchSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: "invalid input" }, 400);
    const { pool } = c.get("deps");
    const user = c.get("user");
    const { rows } = await pool.query(
      `UPDATE users SET
         name = COALESCE($2, name),
         llm_instructions = COALESCE($3, llm_instructions)
       WHERE id = $1
       RETURNING name, email, tier, llm_instructions`,
      [user.id, body.data.name ?? null, body.data.llmInstructions ?? null],
    );
    return c.json({
      profile: {
        name: rows[0].name,
        email: rows[0].email,
        tier: rows[0].tier,
        llmInstructions: rows[0].llm_instructions,
      },
    });
  });

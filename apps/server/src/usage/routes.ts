/** /api/usage — current tier, limits, and consumption for the billing page. */
import { Hono } from "hono";
import { getUsage, TIERS } from "@pigeon/quota";
import type { AppEnv } from "../app.js";
import { requireAuth } from "../auth/middleware.js";

export const usageRoutes = new Hono<AppEnv>()
  .use("*", requireAuth)
  .get("/", async (c) => {
    const { pool } = c.get("deps");
    const user = c.get("user");
    const usage = await getUsage(pool, user.id, user.tier);
    return c.json({
      tier: user.tier,
      period: usage.period,
      usage: {
        mailboxes: usage.mailboxes,
        emailsProcessed: usage.emailsProcessed,
      },
      limits: usage.limits,
      tiers: Object.values(TIERS),
    });
  });

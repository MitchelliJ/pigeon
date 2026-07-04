/** /api/billing — plan state, checkout, Mollie webhook, cancel. */
import { Hono } from "hono";
import { z } from "zod";
import {
  cancelSubscription,
  currentSubscription,
  handlePaymentWebhook,
  startCheckout,
} from "@pigeon/billing";
import { TIERS } from "@pigeon/shared";
import type { AppEnv } from "../app.js";
import { requireAuth } from "../auth/middleware.js";

const checkoutSchema = z.object({
  tier: z.enum(["pro", "team"]),
});

export const billingRoutes = new Hono<AppEnv>()
  // Mollie posts `id=tr_xxx` here — public by design, authenticated by
  // re-fetching the payment from Mollie. Must be registered BEFORE the
  // auth middleware guard below.
  .post("/webhook", async (c) => {
    const { pool, config, logger } = c.get("deps");
    const form = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
    const paymentId = typeof form.id === "string" ? form.id : "";
    if (!paymentId) return c.json({ error: "missing id" }, 400);
    try {
      await handlePaymentWebhook({ pool, config, logger }, paymentId);
    } catch (err) {
      logger.error("billing webhook failed", {
        paymentId,
        error: err instanceof Error ? err.message : String(err),
      });
      return c.json({ error: "webhook processing failed" }, 500); // Mollie retries
    }
    return c.text("ok");
  })

  .use("*", requireAuth)

  .get("/", async (c) => {
    const { pool, config } = c.get("deps");
    const user = c.get("user");
    const subscription = await currentSubscription(pool, user.id);
    return c.json({
      tier: user.tier,
      subscription,
      tiers: Object.values(TIERS),
      mode: config.MOLLIE_API_KEY ? "mollie" : "sandbox",
    });
  })

  .post("/checkout", async (c) => {
    const body = checkoutSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: "tier must be pro or team" }, 400);
    const { pool, config, logger } = c.get("deps");
    const user = c.get("user");
    try {
      const result = await startCheckout(
        { pool, config, logger },
        { id: user.id, name: user.name, email: user.email },
        body.data.tier,
      );
      return c.json(result);
    } catch (err) {
      logger.error("checkout failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      return c.json({ error: "could not start checkout" }, 502);
    }
  })

  .delete("/subscription", async (c) => {
    const { pool, config, logger } = c.get("deps");
    const outcome = await cancelSubscription({ pool, config, logger }, c.get("user").id);
    return c.json({ outcome });
  });

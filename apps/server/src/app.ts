/**
 * Builds the Hono app with its dependencies injected, so tests can exercise
 * routes without binding a socket. Feature routers mount here as they land.
 */
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Config, Logger } from "@pigeon/config";
import { isDbReachable, type Pool } from "@pigeon/db";
import type { Vault } from "@pigeon/vault";
import { authRoutes } from "./auth/routes.js";
import type { AuthUser } from "./auth/service.js";
import { billingRoutes } from "./billing/routes.js";
import { channelRoutes, deliverySettingsRoutes } from "./channels/routes.js";
import { dashboardRoutes } from "./dashboard/routes.js";
import { mailboxRoutes } from "./mailboxes/routes.js";
import { profileRoutes } from "./settings/routes.js";
import { oauthRoutes } from "./oauth/routes.js";
import { privacyRoutes } from "./privacy/routes.js";
import { usageRoutes } from "./usage/routes.js";

export interface AppDeps {
  config: Config;
  logger: Logger;
  pool: Pool;
  vault: Vault;
}

export type AppEnv = {
  Variables: {
    deps: AppDeps;
    /** Set by requireAuth. */
    user: AuthUser;
  };
};

export function createApp(deps: AppDeps) {
  const app = new Hono<AppEnv>();
  const started = Date.now();

  app.use("*", async (c, next) => {
    c.set("deps", deps);
    await next();
  });

  app.use(
    "/api/*",
    cors({
      origin: deps.config.WEB_ORIGIN,
      credentials: true,
    }),
  );

  // Liveness: process is up and serving.
  app.get("/healthz", (c) =>
    c.json({ status: "ok", uptimeMs: Date.now() - started }),
  );

  // Readiness: dependencies (database) reachable.
  app.get("/readyz", async (c) => {
    const dbOk = await isDbReachable(deps.pool);
    return c.json({ status: dbOk ? "ok" : "degraded", db: dbOk }, dbOk ? 200 : 503);
  });

  app.route("/api/auth", authRoutes);
  app.route("/api/mailboxes", mailboxRoutes);
  app.route("/api/channels", channelRoutes);
  app.route("/api/settings/delivery", deliverySettingsRoutes);
  app.route("/api/usage", usageRoutes);
  app.route("/api/billing", billingRoutes);
  app.route("/api/privacy", privacyRoutes);
  app.route("/api/oauth", oauthRoutes);
  app.route("/api/dashboard", dashboardRoutes);
  app.route("/api/settings/profile", profileRoutes);

  app.notFound((c) => c.json({ error: "not found" }, 404));
  app.onError((err, c) => {
    deps.logger.error("unhandled error", {
      path: c.req.path,
      error: err.message,
    });
    return c.json({ error: "internal error" }, 500);
  });

  return app;
}

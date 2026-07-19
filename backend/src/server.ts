/**
 * Pigeon API — HTTP app and process lifecycle.
 *
 * `createApp(db, mail, vault)` builds a Hono app with liveness/readiness
 * endpoints plus every feature router (auth, mailboxes, dashboard, oauth) and
 * is safe to import in tests without binding a port. `serve(...)` is guarded
 * behind `isMain` so it only runs when this module is the entry (tsx watch /
 * tsx src/server.ts); importing `createApp` directly (as the tests do) will
 * not open a socket.
 *
 * `/healthz` proves the process is up; `/readyz` probes the database with a
 * migration-independent `SELECT 1` so readiness can be checked against a DB
 * that has not yet had migrations applied (FR-15). Each feature router
 * already defines its own full paths (e.g. `/api/auth/signup`), so they're
 * mounted at `"/"` rather than under a prefix — mounting at a sub-path would
 * double up the prefix Hono adds when dispatching into the sub-app.
 */
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { pathToFileURL } from "node:url";
import { parseConfig } from "./config/index";
import { createDb } from "./db/index";
import { authRoutes } from "./auth/routes";
import { mailboxesRoutes } from "./mailboxes/routes";
import { dashboardRoutes } from "./mailboxes/dashboard";
import { emailsRoutes } from "./emails/routes";
import { oauthRoutes } from "./oauth/routes";
import { profileRoutes } from "./profile/routes";
import { createMailSender } from "./mail/index";
import { createVault } from "./vault/index";
import { channelRoutes } from "./channels/routes";
import { createChannelRegistry } from "./channels/registry";
import { loadDotEnv } from "./env";
import type { Db } from "./db/index";
import type { MailSender } from "./mail/index";
import type { Vault } from "./vault/index";

/**
 * Build a testable Hono app bound to a `Db`, `MailSender`, and `Vault`.
 *
 * - `GET /healthz` → `200 { ok: true }` (process is up).
 * - `GET /readyz`  → DB reachability probe: `200 { ok: true }` when the pool
 *   can run `SELECT 1`, otherwise `503 { ok: false, reason }`.
 * - Every other route is delegated to the feature routers: `authRoutes`,
 *   `mailboxesRoutes`, `dashboardRoutes`, and `oauthRoutes`.
 */
export function createApp(
  db: Db,
  mail: MailSender,
  vault: Vault,
  channelRegistry: ReturnType<
    typeof createChannelRegistry
  > = createChannelRegistry({ fetch }),
): Hono {
  const app = new Hono();

  /** Liveness: the process is up. */
  app.get("/healthz", (c) => c.json({ ok: true }));

  /** Readiness: safe to receive traffic — the DB pool can answer `SELECT 1`. */
  app.get("/readyz", async (c) => {
    try {
      await db.query`SELECT 1`;
      return c.json({ ok: true }, 200);
    } catch (err) {
      const reason =
        (err instanceof Error ? err.message : String(err)) ||
        "database unreachable";
      return c.json({ ok: false, reason }, 503);
    }
  });

  app.route("/", authRoutes(db, mail));
  app.route("/", mailboxesRoutes(db, vault));
  app.route("/", dashboardRoutes(db));
  app.route("/", emailsRoutes(db));
  app.route("/", oauthRoutes(db));
  app.route("/", profileRoutes(db));
  app.route("/", channelRoutes(db, channelRegistry, vault));

  return app;
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? "").href;

if (isMain) {
  loadDotEnv(); // fills process.env from the repo-root .env, if present
  const config = parseConfig(process.env); // validates env, crashes if bad (FR-12)
  const db = createDb(config.DATABASE_URL);
  const mail = createMailSender(config);
  const vault = createVault(config.VAULT_MASTER_KEY);
  const app = createApp(db, mail, vault);
  const server = serve({ fetch: app.fetch, port: config.PORT }, (info) => {
    console.log(`🕊️  Pigeon API → http://localhost:${info.port}`);
  });
  const shutdown = (signal: string): void => {
    console.log(`\n${signal} received, shutting down.`);
    server.close(() => {
      void db.close().finally(() => process.exit(0));
    });
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

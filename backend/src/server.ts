/**
 * Pigeon API — HTTP app and process lifecycle.
 *
 * `createApp(db)` builds a Hono app with liveness and readiness endpoints and
 * is safe to import in tests without binding a port. `serve(...)` is guarded
 * behind `isMain` so it only runs when this module is the entry (tsx watch /
 * tsx src/server.ts); importing `createApp` directly (as the tests do) will
 * not open a socket.
 *
 * `/healthz` proves the process is up; `/readyz` probes the database with a
 * migration-independent `SELECT 1` so readiness can be checked against a DB
 * that has not yet had migrations applied (FR-15).
 */
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { pathToFileURL } from "node:url";
import { parseConfig } from "./config/index";
import { createDb } from "./db/index";
import type { Db } from "./db/index";

/**
 * Build a testable Hono app bound to a `Db`.
 *
 * - `GET /healthz` → `200 { ok: true }` (process is up).
 * - `GET /readyz`  → DB reachability probe: `200 { ok: true }` when the pool
 *   can run `SELECT 1`, otherwise `503 { ok: false, reason }`.
 */
export function createApp(db: Pick<Db, "query">): Hono {
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

  return app;
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? "").href;

if (isMain) {
  const config = parseConfig(process.env); // validates env, crashes if bad (FR-12)
  const db = createDb(config.DATABASE_URL);
  const app = createApp(db);
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

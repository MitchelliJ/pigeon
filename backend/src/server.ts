/**
 * Pigeon API — minimal runtime scaffold.
 *
 * Deliberately bare: just liveness/readiness endpoints and graceful shutdown.
 * Business logic (auth, mailboxes, triage, delivery, billing, …) is added
 * feature-by-feature during development, each with its own module + migrations.
 */
import { serve } from "@hono/node-server";
import { Hono } from "hono";

const app = new Hono();

/** Liveness: the process is up. */
app.get("/healthz", (c) => c.json({ ok: true }));

/**
 * Readiness: safe to receive traffic. Today it mirrors liveness; once the
 * database lands (feature 1) this also checks the DB is reachable.
 */
app.get("/readyz", (c) => c.json({ ok: true }));

const port = Number(process.env.PORT ?? 8788);

const server = serve({ fetch: app.fetch, port }, (info) => {
  console.log(`🕊️  Pigeon API → http://localhost:${info.port}`);
});

function shutdown(signal: string): void {
  console.log(`\n${signal} received, shutting down.`);
  server.close(() => process.exit(0));
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

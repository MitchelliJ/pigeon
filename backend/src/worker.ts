/**
 * Pigeon worker — queue/scheduler process and lifecycle.
 *
 * The worker will host the durable job queue + scheduler (feature 5) and run
 * sync/triage/delivery jobs. For now it just proves the runtime is alive with
 * a periodic heartbeat and shuts down cleanly.
 *
 * The worker opens a validated `Db` pool at startup (so config validation
 * gates the process per FR-12 and migrations can run against it) and closes
 * that pool on shutdown so the connection pool does not leak. The heartbeat
 * loop runs only when this module is the entry (`isMain`); importing the
 * module does not start anything.
 */
import { pathToFileURL } from "node:url";
import { parseConfig } from "./config/index";
import { createDb } from "./db/index";
import type { Db } from "./db/index";

const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? "").href;

if (isMain) {
  const config = parseConfig(process.env);
  const db: Db = createDb(config.DATABASE_URL);
  const HEARTBEAT_MS = config.WORKER_HEARTBEAT_INTERVAL_MS;

  console.log("🕊️  Pigeon worker started");

  const timer = setInterval(() => {
    console.log(`worker heartbeat @ ${new Date().toISOString()}`);
  }, HEARTBEAT_MS);

  const shutdown = (signal: string): void => {
    console.log(`\n${signal} received, shutting down.`);
    clearInterval(timer);
    void db.close().finally(() => process.exit(0));
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

/**
 * Pigeon worker — queue/scheduler process and lifecycle.
 *
 * The worker hosts the durable job queue + scheduler (Job Queue, Workers &
 * Scheduler PRD §3.2, FR-12): a scheduler tick enqueues due `sync_mailbox`
 * jobs and a worker tick claims + runs them, both on their own intervals
 * alongside the pre-existing heartbeat that proves the runtime is alive.
 *
 * The worker opens a validated `Db` pool and a `Vault` at startup (so config
 * validation gates the process per FR-12 and the vault is ready before any
 * job needs to open a sealed credential) and closes the pool on shutdown so
 * the connection pool does not leak. The interval loops run only when this
 * module is the entry (`isMain`); importing the module does not start
 * anything.
 */
import { pathToFileURL } from "node:url";
import { parseConfig } from "./config/index";
import { createDb } from "./db/index";
import type { Db } from "./db/index";
import { createVault } from "./vault/index";
import { createLlmClassifier } from "./llm/index";
import { runSchedulerTick, enqueueDueClassifyJobs } from "./queue/scheduler";
import { runWorkerTick } from "./queue/worker-loop";
import { loadDotEnv } from "./env";

const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? "").href;

if (isMain) {
  loadDotEnv(); // fills process.env from the repo-root .env, if present
  const config = parseConfig(process.env);
  const db: Db = createDb(config.DATABASE_URL);
  const vault = createVault(config.VAULT_MASTER_KEY);
  const classifier = createLlmClassifier(config);
  const HEARTBEAT_MS = config.WORKER_HEARTBEAT_INTERVAL_MS;

  console.log("🕊️  Pigeon worker started");

  const timer = setInterval(() => {
    console.log(`worker heartbeat @ ${new Date().toISOString()}`);
  }, HEARTBEAT_MS);

  // A single failed tick must not crash the worker process or stop future
  // ticks, so every tick's rejection is caught and logged here rather than
  // left to reject inside `setInterval` (which can't take an async callback
  // without risking an unhandled rejection).
  const schedulerTimer = setInterval(() => {
    void runSchedulerTick(db).catch((err: unknown) => {
      console.error("[scheduler] tick failed:", err);
    });
  }, config.SCHEDULER_INTERVAL_MS);

  const classifySchedulerTimer = setInterval(() => {
    void enqueueDueClassifyJobs(db).catch((err: unknown) => {
      console.error("[scheduler] classify tick failed:", err);
    });
  }, config.SCHEDULER_INTERVAL_MS);

  const workerTimer = setInterval(() => {
    void runWorkerTick(
      db,
      vault,
      config.WORKER_CONCURRENCY,
      undefined,
      classifier,
    ).catch((err: unknown) => {
      console.error("[worker] tick failed:", err);
    });
  }, config.WORKER_POLL_INTERVAL_MS);

  const shutdown = (signal: string): void => {
    console.log(`\n${signal} received, shutting down.`);
    clearInterval(timer);
    clearInterval(schedulerTimer);
    clearInterval(classifySchedulerTimer);
    clearInterval(workerTimer);
    void db.close().finally(() => process.exit(0));
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

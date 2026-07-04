/**
 * Pigeon worker entrypoint: heartbeat, job runner, periodic scheduler.
 * Handlers and periodic tasks register in ./jobs/index.ts as features land.
 */
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { loadConfig, createLogger, configSummary, ConfigError } from "@pigeon/config";
import { createPool, waitForDb } from "@pigeon/db";
import { registerChannelConnectors } from "@pigeon/deliver";
import { registerOAuthProviders } from "@pigeon/mail";
import { createRunner, createScheduler } from "@pigeon/queue";
import { createVaultFromMasterKey } from "@pigeon/vault";
import { registerJobs } from "./jobs/index.js";

let config;
try {
  config = loadConfig();
} catch (err) {
  console.error(err instanceof ConfigError ? err.message : err);
  process.exit(1);
}

const workerId = `${hostname()}-${process.pid}-${randomUUID().slice(0, 8)}`;
const logger = createLogger(config.LOG_LEVEL, { name: "worker", bound: { workerId } });
logger.info("starting", configSummary(config));

const pool = createPool(config, logger);
await waitForDb(pool, { logger, attempts: 60 });

const startedAt = new Date();

async function heartbeat() {
  try {
    await pool.query(
      `INSERT INTO worker_heartbeats (worker_id, started_at, seen_at)
       VALUES ($1, $2, now())
       ON CONFLICT (worker_id) DO UPDATE SET seen_at = now()`,
      [workerId, startedAt],
    );
    logger.debug("heartbeat");
  } catch (err) {
    logger.warn("heartbeat failed", { error: err instanceof Error ? err.message : String(err) });
  }
}

await heartbeat();
const heartbeatTimer = setInterval(
  () => void heartbeat(),
  config.WORKER_HEARTBEAT_INTERVAL_MS,
);

const vault = createVaultFromMasterKey(config.VAULT_MASTER_KEY);
registerChannelConnectors(config, logger);
registerOAuthProviders(config);
const runner = createRunner(pool, logger.child("jobs"));
const { periodicTasks } = registerJobs(runner, { config, logger, vault });
const scheduler = createScheduler(pool, logger.child("scheduler"), periodicTasks);
scheduler.start();
const runnerDone = runner.start();

logger.info("running", {
  heartbeatEveryMs: config.WORKER_HEARTBEAT_INTERVAL_MS,
  periodicTasks: periodicTasks.map((t) => t.name),
});

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info("shutting down", { signal });
  scheduler.stop();
  clearInterval(heartbeatTimer);
  await runner.stop();
  await runnerDone.catch(() => {});
  await pool.query("DELETE FROM worker_heartbeats WHERE worker_id = $1", [workerId]).catch(() => {});
  await pool.end().catch(() => {});
  logger.info("bye");
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

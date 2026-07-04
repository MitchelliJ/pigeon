/** Pigeon backend entrypoint: load config, connect the pool, serve, shut down cleanly. */
import { serve } from "@hono/node-server";
import { loadConfig, createLogger, configSummary, ConfigError } from "@pigeon/config";
import { createPool, waitForDb } from "@pigeon/db";
import { registerChannelConnectors } from "@pigeon/deliver";
import { registerOAuthProviders } from "@pigeon/mail";
import { createVaultFromMasterKey } from "@pigeon/vault";
import { createApp } from "./app.js";

let config;
try {
  config = loadConfig();
} catch (err) {
  console.error(err instanceof ConfigError ? err.message : err);
  process.exit(1);
}

const logger = createLogger(config.LOG_LEVEL, { name: "server" });
logger.info("starting", configSummary(config));

const pool = createPool(config, logger);
// Don't fail hard in dev when Postgres starts in parallel; readiness stays
// 503 until the DB answers.
waitForDb(pool, { logger, attempts: 60 }).catch((err) =>
  logger.error("database never became reachable", { error: String(err) }),
);

const vault = createVaultFromMasterKey(config.VAULT_MASTER_KEY);
registerChannelConnectors(config, logger);
const oauth = registerOAuthProviders(config);
if (oauth.length > 0) {
  logger.info("oauth providers enabled", { providers: oauth.map((p) => p.def.id) });
}
const app = createApp({ config, logger, pool, vault });

const server = serve(
  { fetch: app.fetch, hostname: config.HOST, port: config.PORT },
  (info) => logger.info("listening", { host: info.address, port: info.port }),
);

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info("shutting down", { signal });
  server.close(async () => {
    await pool.end().catch(() => {});
    logger.info("bye");
    process.exit(0);
  });
  // Hard exit if close hangs (open keep-alive sockets).
  setTimeout(() => process.exit(0), 8_000).unref();
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

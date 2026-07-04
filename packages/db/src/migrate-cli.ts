/** CLI entrypoint: `pnpm migrate` (root) / `pnpm --filter @pigeon/db migrate`. */
import { loadConfig, createLogger } from "@pigeon/config";
import { createPool } from "./index.js";
import { runMigrations } from "./migrate.js";

const config = loadConfig();
const logger = createLogger(config.LOG_LEVEL, { name: "migrate" });
const pool = createPool(config, logger);

try {
  const result = await runMigrations(pool, { logger });
  logger.info("migrations complete", {
    applied: result.applied.length,
    alreadyApplied: result.alreadyApplied,
  });
} catch (err) {
  logger.error("migration run failed", {
    error: err instanceof Error ? err.message : String(err),
  });
  process.exitCode = 1;
} finally {
  await pool.end();
}

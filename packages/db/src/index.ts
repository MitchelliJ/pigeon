/**
 * Shared PostgreSQL access for Pigeon — connection pool, query helpers,
 * and readiness checks. Hand-written SQL everywhere; no ORM.
 */
import pg from "pg";
import type { Config, Logger } from "@pigeon/config";

export type { Pool, PoolClient, QueryResult, QueryResultRow } from "pg";

export function createPool(config: Config, logger?: Logger): pg.Pool {
  const pool = new pg.Pool({
    connectionString: config.DATABASE_URL,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
  pool.on("error", (err) => {
    logger?.error("idle postgres client error", { error: err.message });
  });
  return pool;
}

/** True when the database answers `SELECT 1` within the pool's timeout. */
export async function isDbReachable(pool: pg.Pool): Promise<boolean> {
  try {
    await pool.query("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

/**
 * Wait for the database to accept connections — used at process startup so
 * services survive being started in parallel with Postgres (compose, dev).
 */
export async function waitForDb(
  pool: pg.Pool,
  { attempts = 30, delayMs = 1000, logger }: { attempts?: number; delayMs?: number; logger?: Logger } = {},
): Promise<void> {
  for (let i = 1; i <= attempts; i++) {
    if (await isDbReachable(pool)) return;
    logger?.info("waiting for database", { attempt: i, of: attempts });
    await new Promise((r) => setTimeout(r, delayMs));
  }
  throw new Error(`database unreachable after ${attempts} attempts`);
}

/** Run `fn` inside a transaction; rolls back on any throw. */
export async function withTransaction<T>(
  pool: pg.Pool,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export { runMigrations } from "./migrate.js";
export { audit, type AuditEntry } from "./audit.js";

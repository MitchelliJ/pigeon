/*
 * Migration CLI entry (`main`).
 *
 * The CLI boundary: reads `process.env` via `parseConfig`, builds a `Db` from
 * the validated `DATABASE_URL`, applies migrations via `runMigrations`, then
 * closes the db — returning an exit code (0 on success, 1 on any caught
 * failure). The entire body is wrapped in the try/catch so a config validation
 * crash (e.g. missing DATABASE_URL in production) ALSO surfaces as exit 1 with
 * a stderr message instead of an uncaught throw. `main` is free of top-level
 * side effects so tests can import it without tripping an auto-run; the actual
 * runnable shim lives in `./cli.ts`.
 */
import type { Db } from "../db/index";
import { parseConfig } from "../config/index";
import { createDb } from "../db/index";
import { runMigrations } from "./runner";

/**
 * Run migrations against the configured database and return a process exit
 * code. Never throws — every failure (config, connection, migration) is caught
 * and reported to stderr as a non-zero exit.
 */
export async function main(): Promise<number> {
  let db: Db | undefined;
  try {
    const config = parseConfig(process.env);
    db = createDb(config.DATABASE_URL);
    await runMigrations(db);
    return 0;
  } catch (err) {
    console.error(
      "Migration failed:",
      err instanceof Error ? err.message : String(err),
    );
    return 1;
  } finally {
    if (db) await db.close();
  }
}

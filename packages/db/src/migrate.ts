/**
 * Minimal migration runner: applies `migrations/NNNN_name.sql` files in
 * lexicographic order, each inside its own transaction, recorded in
 * `schema_migrations`. A Postgres advisory lock makes concurrent runs safe
 * (second runner blocks, then sees everything applied).
 */
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import type { Logger } from "@pigeon/config";

const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "migrations",
);

// Arbitrary fixed key identifying "pigeon migrations" for the advisory lock.
const LOCK_KEY = 7_1_6_3_0_9;

export interface MigrationResult {
  applied: string[];
  alreadyApplied: number;
}

export async function runMigrations(
  pool: pg.Pool,
  { logger, dir = MIGRATIONS_DIR }: { logger?: Logger; dir?: string } = {},
): Promise<MigrationResult> {
  const files = (await readdir(dir))
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query("SELECT pg_advisory_lock($1)", [LOCK_KEY]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version    text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    const { rows } = await client.query<{ version: string }>(
      "SELECT version FROM schema_migrations",
    );
    const done = new Set(rows.map((r) => r.version));

    for (const file of files) {
      if (done.has(file)) continue;
      const sql = await readFile(join(dir, file), "utf8");
      logger?.info("applying migration", { file });
      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query(
          "INSERT INTO schema_migrations (version) VALUES ($1)",
          [file],
        );
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw new Error(
          `migration ${file} failed: ${err instanceof Error ? err.message : err}`,
        );
      }
      applied.push(file);
    }
    return { applied, alreadyApplied: done.size };
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]).catch(() => {});
    client.release();
  }
}

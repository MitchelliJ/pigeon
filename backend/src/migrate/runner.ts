/*
 * Forward-only SQL migration runner (infrastructure PRD FR-5..FR-8).
 *
 * Discovers `NNNN_name.sql` files under `db/migrations/` at the repo root,
 * tracks applied migrations in the `schema_migrations` table, and applies any
 * unapplied files in numeric order — each applied via `withTx` (postgres.js
 * `sql.begin`) with rollback on error. Idempotent: already-applied ids are skipped (FR-7). An out-of-order
 * guard (FR-8) refuses to run when the database's highest applied id exceeds
 * the highest migration file on disk, which signals that the code on disk is
 * behind the database (e.g. a rolled-back deploy) and silent re-application of
 * lower ids would mask a real divergence.
 */
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { readFile } from "node:fs/promises";
import type { Db } from "../db/index";

/** Numeric id parsed from a `NNNN_*.sql` filename. Matches the leading digits. */
const ID_RE = /^(\d+)_/;

/**
 * Locate the `db/migrations` directory relative to the current working
 * directory. Tests and `pnpm test` run from the repo root, so the primary
 * `db/migrations` path resolves directly; when the runner is invoked with cwd
 * inside `backend/` we fall back to `../db/migrations`.
 */
async function resolveMigrationsDir(): Promise<string> {
  const primary = resolve(process.cwd(), "db/migrations");
  try {
    await readdir(primary);
    return primary;
  } catch {
    const fallback = resolve(process.cwd(), "../db/migrations");
    await readdir(fallback);
    return fallback;
  }
}

/** Discover migration files, returning `{ id, filename, path }` sorted by id. */
async function discoverMigrations(
  dir: string,
): Promise<Array<{ id: number; filename: string; path: string }>> {
  const entries = await readdir(dir);
  const files = entries.filter((f) => f.endsWith(".sql"));
  return files
    .map((filename) => {
      const match = ID_RE.exec(filename);
      if (!match) return undefined;
      const id = Number(match[1]);
      return { id, filename, path: resolve(dir, filename) };
    })
    .filter(
      (m): m is { id: number; filename: string; path: string } =>
        m !== undefined,
    )
    .sort((a, b) => a.id - b.id);
}

export async function runMigrations(
  db: Pick<Db, "query" | "withTx">,
): Promise<void> {
  const dir = await resolveMigrationsDir();
  const migrations = await discoverMigrations(dir);
  const maxIdOnDisk = migrations.reduce((max, m) => Math.max(max, m.id), 0);

  // Ensure the tracking table exists first. This is idempotent — the `0001`
  // migration also creates it with `IF NOT EXISTS` — and lets the runner boot
  // on a bare cluster before `0001` is even applied.
  await db.query`CREATE TABLE IF NOT EXISTS schema_migrations (id BIGINT PRIMARY KEY, filename TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`;

  const appliedRows = await db.query`SELECT id FROM schema_migrations`;
  const appliedIds = new Set<number>(
    appliedRows.map((row) => Number(row.id as number)),
  );
  const maxApplied = appliedRows.reduce(
    (max, row) => Math.max(max, Number(row.id as number)),
    0,
  );

  // FR-8: out-of-order guard. If the database has an applied id higher than any
  // file on disk, the code is behind the database — refuse to proceed rather
  // than silently re-running lower ids.
  if (maxApplied > maxIdOnDisk) {
    throw new Error(
      `Migration state out of order: applied id ${maxApplied} exceeds the highest migration file on disk (${maxIdOnDisk})`,
    );
  }

  for (const m of migrations) {
    if (appliedIds.has(m.id)) continue;

    const fileText = await readFile(m.path, "utf8");

    // Each migration applies inside its own `withTx` (postgres.js `sql.begin`),
    // which issues ROLLBACK on a thrown error so a failed migration never
    // records a tracking row (FR-6).
    await db.withTx(async (tx) => {
      await tx.unsafe(fileText);
      await tx`INSERT INTO schema_migrations (id, filename) VALUES (${m.id}, ${m.filename})`;
    });
  }
}

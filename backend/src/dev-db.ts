/*
 * Local dev Postgres — a persistent embedded-postgres cluster for `pnpm dev`
 * / `pnpm dev:worker` / `pnpm migrate`, so local development never depends on
 * Docker. Reuses the same `embedded-postgres` package the test harness
 * (`backend/test/db.ts`) already boots per-test, but with `persistent: true`
 * and a fixed data directory + port instead of a random throwaway one, so
 * data survives across restarts.
 *
 * Listens on the exact connection string `parseConfig` already falls back to
 * in development (`postgres://pigeon:pigeon@localhost:5432/pigeon`) — no
 * `DATABASE_URL` needed in `.env` for local dev.
 *
 * Run with `pnpm dev:db` in its own terminal, alongside `pnpm dev` and
 * `pnpm dev:worker`. Ctrl+C stops the cluster; the data directory (`.pgdata/`
 * at the repo root, git-ignored) is left in place for next time.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import EmbeddedPg from "embedded-postgres";

const DATA_DIR = join(import.meta.dirname, "..", "..", ".pgdata");
const PORT = 5432;

const pg = new EmbeddedPg({
  databaseDir: DATA_DIR,
  port: PORT,
  user: "pigeon",
  password: "pigeon",
  persistent: true,
});

// `initialise()` populates a fresh data directory; calling it again against
// an already-initialised one is unnecessary (and the package's own docs say
// so), so only run it the first time — detected by the presence of
// Postgres's own `PG_VERSION` marker file.
const alreadyInitialised = existsSync(join(DATA_DIR, "PG_VERSION"));
if (!alreadyInitialised) {
  console.log("Initialising a fresh local Postgres cluster in .pgdata/ ...");
  await pg.initialise();
}

await pg.start();

if (!alreadyInitialised) {
  await pg.createDatabase("pigeon");
}

console.log(
  `🐘 Pigeon dev Postgres ready → postgres://pigeon:pigeon@localhost:${String(PORT)}/pigeon`,
);
console.log("Press Ctrl+C to stop (data persists in .pgdata/ for next time).");

const shutdown = (): void => {
  console.log("\nStopping dev Postgres...");
  pg.stop()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// Keep the process alive until Ctrl+C/SIGTERM.
await new Promise<void>(() => {});

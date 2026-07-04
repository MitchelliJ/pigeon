/**
 * Local development Postgres without Docker: runs real Postgres binaries
 * (embedded-postgres) with a persistent data dir at <repo>/.pgdata.
 *
 * Started automatically as part of `pnpm dev`, or standalone via
 * `pnpm dev:db`. Defaults match the root .env.example:
 *   postgres://pigeon:pigeon@localhost:5433/pigeon
 */
import { existsSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { join, resolve } from "node:path";
import EmbeddedPostgres from "embedded-postgres";

const PORT = Number(process.env.DEVDB_PORT ?? 5433);
const DATA_DIR = resolve(process.env.DEVDB_DATA_DIR ?? join(import.meta.dirname, "..", "..", "..", ".pgdata"));
const DB_NAME = "pigeon";

/** True when something is already accepting connections on the port. */
function portInUse(port: number): Promise<boolean> {
  return new Promise((resolvePort) => {
    const socket = connect({ host: "127.0.0.1", port, timeout: 1500 });
    socket.once("connect", () => {
      socket.destroy();
      resolvePort(true);
    });
    socket.once("error", () => resolvePort(false));
    socket.once("timeout", () => {
      socket.destroy();
      resolvePort(false);
    });
  });
}

// A cluster is already serving (another `pnpm dev`, a stray terminal, …):
// reuse it instead of crashing the whole parallel dev run.
if (await portInUse(PORT)) {
  console.log(`[devdb] postgres already running on port ${PORT} — reusing it`);
  console.log(`[devdb] connection string: postgres://pigeon:pigeon@localhost:${PORT}/${DB_NAME}`);
  // Stay alive so Ctrl+C semantics match a normal run; owns nothing.
  setInterval(() => {}, 1 << 30);
} else {
  // Nothing listening: a leftover postmaster.pid is stale (previous run was
  // killed hard). Postgres refuses to start over it, so clear it.
  const stalePid = join(DATA_DIR, "postmaster.pid");
  if (existsSync(stalePid)) {
    console.log("[devdb] removing stale postmaster.pid (no server is listening)");
    rmSync(stalePid, { force: true });
  }
  await main();
}

async function main(): Promise<void> {
const alreadyInitialised = existsSync(join(DATA_DIR, "PG_VERSION"));

const cluster = new EmbeddedPostgres({
  databaseDir: DATA_DIR,
  user: "pigeon",
  password: "pigeon",
  port: PORT,
  persistent: true,
  // Windows initdb defaults to the OS locale (WIN1252) which rejects
  // emoji and most non-Latin mail. Real mail requires UTF8.
  initdbFlags: ["--encoding=UTF8", "--locale=C"],
});

if (!alreadyInitialised) {
  console.log(`[devdb] initialising new cluster in ${DATA_DIR}`);
  await cluster.initialise();
}

await cluster.start();

if (!alreadyInitialised) {
  await cluster.createDatabase(DB_NAME);
}

console.log(`[devdb] postgres ready on port ${PORT} (db: ${DB_NAME}, data: ${DATA_DIR})`);
console.log(`[devdb] connection string: postgres://pigeon:pigeon@localhost:${PORT}/${DB_NAME}`);

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  console.log(`[devdb] ${signal} received, stopping postgres...`);
  await cluster.stop();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

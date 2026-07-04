/**
 * Test support: spin up a throwaway real Postgres (embedded-postgres, no
 * Docker required), run all migrations, hand back a pool. Each caller gets
 * an isolated cluster in a temp dir on a free port; `stop()` removes it.
 */
import { mkdtemp } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { runMigrations } from "./migrate.js";

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address();
      if (address && typeof address === "object") {
        const port = address.port;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error("no port")));
      }
    });
    srv.on("error", reject);
  });
}

export interface TestDb {
  pool: pg.Pool;
  connectionString: string;
  stop(): Promise<void>;
}

export async function startTestDb(
  { migrate = true }: { migrate?: boolean } = {},
): Promise<TestDb> {
  const port = await freePort();
  const dataDir = await mkdtemp(join(tmpdir(), "pigeon-testdb-"));
  const cluster = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: "pigeon",
    password: "pigeon",
    port,
    persistent: false,
    // Windows initdb defaults to the OS locale (WIN1252) which rejects
    // emoji and most non-Latin mail. Real mail requires UTF8.
    initdbFlags: ["--encoding=UTF8", "--locale=C"],
  });
  await cluster.initialise();
  await cluster.start();
  await cluster.createDatabase("pigeon_test");

  const connectionString = `postgres://pigeon:pigeon@127.0.0.1:${port}/pigeon_test`;
  const pool = new pg.Pool({ connectionString, max: 5 });
  if (migrate) await runMigrations(pool);

  return {
    pool,
    connectionString,
    async stop() {
      await pool.end().catch(() => {});
      await cluster.stop();
    },
  };
}

/*
 * Embedded-Postgres integration test harness.
 *
 * Boots a real Postgres cluster per test file on a random free port with a
 * throwaway temp data directory, hands back a `Db` client wired to it, and
 * tears the cluster down on `close()`. This lets integration tests exercise
 * genuine SQL with no Docker/admin or CI service dependency, per the coding
 * guidelines (§"Where tests live") and PRD FR-16..FR-18.
 *
 * Note: `embedded-postgres` ships platform-specific binaries installed via a
 * postinstall script. Its package must be listed under `onlyBuiltDependencies`
 * in `pnpm-workspace.yaml`, otherwise pnpm skips the postinstall and the
 * harness fails to boot the cluster.
 */
import { createServer, type AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import EmbeddedPg from "embedded-postgres";
import { createDb } from "../src/db/index";
import type { Db } from "../src/db/index";

export type TestDb = {
  db: Db;
  /** Live `DATABASE_URL` for this cluster — handy for pointing a CLI entry at the same instance. */
  connectionString: string;
  close: () => Promise<void>;
};

/** Reserve an ephemeral free TCP port by briefly listening on port 0. */
function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on("error", reject);
    srv.listen(0, () => {
      const { port } = srv.address() as AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}

/**
 * Boot an isolated embedded Postgres and return a `Db` + `close()` pair.
 * The cluster is configured with `pigeon/pigeon/pigeon` user/db/password to
 * match the docker-compose values.
 */
export async function withTestDb(): Promise<TestDb> {
  const dataDir = join(tmpdir(), `pigeon-pg-${randomUUID()}`);
  const port = await getFreePort();

  const pg = new EmbeddedPg({
    databaseDir: dataDir,
    port,
    user: "pigeon",
    password: "pigeon",
    persistent: false,
  });

  await pg.initialise();
  await pg.start();
  await pg.createDatabase("pigeon");

  const connectionString = `postgres://pigeon:pigeon@localhost:${port}/pigeon`;
  const db = createDb(connectionString);

  const close = async (): Promise<void> => {
    await db.close();
    await pg.stop();
    await rm(dataDir, { recursive: true, force: true });
  };

  return { db, connectionString, close };
}

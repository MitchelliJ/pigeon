/*
 * Migrate CLI entry tests (`backend/src/migrate/index.ts`).
 *
 * Exercises the real CLI boundary `main()` against a live embedded Postgres
 * cluster: it reads `process.env` via `parseConfig`, builds a `Db`, applies
 * migrations via `runMigrations`, closes the db, and returns an exit code
 * (0 on success, 1 on a caught error). Because `main` reads `DATABASE_URL`
 * from `process.env` directly, these tests set/restore that env var around
 * each call rather than injecting a factory. The harness exposes the cluster's
 * live `connectionString` so we can point `main()` (and a separate verify
 * client) at the same instance.
 */
import { describe, it, expect } from "vitest";
import { withTestDb } from "./db";
import { main } from "../src/migrate/index";
import { createDb } from "../src/db/index";

describe("migrate CLI main()", () => {
  it("returns 0 on success and applies migrations to the database", async () => {
    const originalUrl = process.env.DATABASE_URL;
    const originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "test";
    const { connectionString, close } = await withTestDb();
    process.env.DATABASE_URL = connectionString;
    try {
      const code = await main();
      expect(code).toBe(0);

      // Verify migrations actually ran by querying via a fresh client pointed
      // at the same cluster, independent of whatever `main` built/closed.
      const verify = createDb(connectionString);
      try {
        const rows =
          await verify.query`SELECT count(*)::int AS n FROM schema_migrations`;
        expect(rows[0]?.n).toBe(2);
      } finally {
        await verify.close();
      }
    } finally {
      await close();
      if (originalUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = originalUrl;
      if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = originalNodeEnv;
    }
  });

  it("returns non-zero when DATABASE_URL is unreachable", async () => {
    const originalUrl = process.env.DATABASE_URL;
    const originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "test";
    // Port 1 is reserved/unroutable → the connection rejects with ECONNREFUSED,
    // which `main` must catch and surface as a non-zero exit code.
    process.env.DATABASE_URL = "postgres://nobody:nopw@127.0.0.1:1/nope";
    try {
      const code = await main();
      expect(code).not.toBe(0);
    } finally {
      if (originalUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = originalUrl;
      if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = originalNodeEnv;
    }
  });
});

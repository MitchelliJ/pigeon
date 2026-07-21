import { defineConfig, configDefaults } from "vitest/config";

// Two projects with an executable unit/integration boundary:
//
// - `unit`  — pure logic, never boots infrastructure. Runs in parallel and is
//   the phase gate (`pnpm check`), so it must stay fast.
// - `integration` — `*.integration.test.ts` + `*.e2e.test.ts`, each of which
//   boots a real embedded Postgres via `backend/test/db.ts`. Kept to a single
//   fork: concurrent clusters race the postmaster/exit hooks on Windows and
//   flap CI. Slower but reliable, and the engine is genuine.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: [
            "backend/**/test/**/*.test.ts",
            "shared/**/test/**/*.test.ts",
            "frontend/src/**/*.test.ts",
          ],
          exclude: [
            ...configDefaults.exclude,
            "**/*.integration.test.ts",
            "**/*.e2e.test.ts",
          ],
          env: {
            NODE_ENV: "test",
          },
        },
      },
      {
        test: {
          name: "integration",
          include: [
            "backend/**/test/**/*.integration.test.ts",
            "backend/**/test/**/*.e2e.test.ts",
            "shared/**/test/**/*.integration.test.ts",
            "shared/**/test/**/*.e2e.test.ts",
          ],
          testTimeout: 60_000,
          hookTimeout: 180_000,
          pool: "forks",
          poolOptions: {
            forks: {
              singleFork: true,
            },
          },
          env: {
            NODE_ENV: "test",
          },
        },
      },
    ],
  },
});

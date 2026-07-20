import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "backend/**/test/**/*.test.ts",
      "shared/**/test/**/*.test.ts",
      "frontend/src/**/*.test.ts",
    ],
    // Integration suites (added per-feature) may boot a real embedded
    // Postgres; give them room.
    testTimeout: 60_000,
    hookTimeout: 180_000,
    pool: "forks",
    // Run every test file in ONE forked process, sequentially. Integration
    // suites each boot a real embedded Postgres cluster; starting several
    // at once (the default `forks` concurrency) races the postmaster/exit
    // hooks on Windows and flaps CI. A single fork boots one cluster at a
    // time — slower but reliable, and the engine is still genuine.
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
    env: {
      NODE_ENV: "test",
    },
  },
});

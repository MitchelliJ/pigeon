import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "apps/**/test/**/*.test.ts",
      "packages/**/test/**/*.test.ts",
    ],
    // Integration suites boot a real embedded Postgres; give them room.
    testTimeout: 60_000,
    hookTimeout: 180_000,
    pool: "forks",
    env: {
      NODE_ENV: "test",
    },
  },
});

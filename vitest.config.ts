import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "backend/**/test/**/*.test.ts",
      "shared/**/test/**/*.test.ts",
    ],
    // Integration suites (added per-feature) may boot a real embedded
    // Postgres; give them room.
    testTimeout: 60_000,
    hookTimeout: 180_000,
    pool: "forks",
    env: {
      NODE_ENV: "test",
    },
  },
});

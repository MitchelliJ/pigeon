import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Load the nearest `.env` into `process.env` (values already present win).
 *
 * pnpm runs package scripts with the package directory as cwd, so the repo
 * root `.env` is found by walking upward. Uses Node 22's built-in
 * `process.loadEnvFile` — no dotenv dependency.
 */
export function loadNearestDotenv(startDir = process.cwd()): string | null {
  let dir = startDir;
  for (let depth = 0; depth < 6; depth++) {
    const candidate = join(dir, ".env");
    if (existsSync(candidate)) {
      const before = { ...process.env };
      process.loadEnvFile(candidate);
      // loadEnvFile overwrites; restore pre-existing values so real env wins.
      for (const [key, value] of Object.entries(before)) {
        process.env[key] = value;
      }
      return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

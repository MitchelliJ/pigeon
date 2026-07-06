/*
 * Minimal `.env` loader — no `dotenv` dependency, matching the project's
 * hand-rolled-over-library pattern (see the POP3 connector). Reads the
 * repo-root `.env` (git-ignored, documented in `.env.example`) once and
 * fills in any `process.env` keys that aren't already set — real
 * environment variables (shell exports, docker-compose's `environment:`
 * block) always win, this only fills gaps.
 *
 * Only ever called from an actual process entrypoint's `isMain` block
 * (`server.ts`, `worker.ts`, `migrate/cli.ts`, `invite-cli.ts`) — never at
 * module top-level and never from anything a test imports — so it can
 * never leak real `.env` values into a test's carefully-isolated
 * `process.env` manipulation (see `migrate-cli.test.ts`/`invite-cli.test.ts`).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ENV_FILE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  ".env",
);

/**
 * Parse `.env`-style file contents into a flat `KEY -> value` map. Blank
 * lines and full-line comments (`#`) are skipped; a value wrapped in
 * matching single/double quotes has them stripped. No interpolation, no
 * multi-line values — just enough to cover `.env.example`'s shape.
 */
export function parseEnvFile(contents: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawLine of contents.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (!key) continue;
    let value = line.slice(eq + 1).trim();
    const isQuoted =
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")));
    if (isQuoted) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

/**
 * Load the repo-root `.env` file into `process.env`, filling only keys
 * that aren't already set. A missing file is a silent no-op — fine in
 * production/Docker, where env vars are injected directly, never via
 * this file.
 */
export function loadDotEnv(): void {
  let contents: string;
  try {
    contents = readFileSync(ENV_FILE_PATH, "utf8");
  } catch {
    return;
  }
  for (const [key, value] of Object.entries(parseEnvFile(contents))) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

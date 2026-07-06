/*
 * Invite-minting CLI (Authentication & User Accounts PRD Sec. 3.1.9, FR-24,
 * FR-25, AC-7).
 *
 * The CLI boundary: reads `process.env` via `parseConfig`, builds a `Db` from
 * the validated `DATABASE_URL`, inserts N `invites` rows (`--count <n>`,
 * default 1), optionally with a TTL (`--ttl <duration>`), prints each
 * plaintext code to stdout — one per line — then closes the db and returns an
 * exit code (0 on success, 1 on any caught failure). This is a one-shot job,
 * never starting the HTTP server. Modeled on `migrate/index.ts`'s `main()`.
 *
 * Only the sha256 `code_hash` is ever persisted — the plaintext code exists
 * only in memory long enough to print it, per the "secrets never hit the
 * database in plaintext" rule.
 */
import { pathToFileURL } from "node:url";
import type { Db } from "../db/index";
import { parseConfig } from "../config/index";
import { createDb } from "../db/index";
import { generateInviteCode, hashToken } from "./tokens";
import { loadDotEnv } from "../env";

const DURATION_UNIT_MS: Record<string, number> = {
  s: 1000,
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
};

/**
 * Parse a tiny duration string like `7d` or `1s` into milliseconds. Supports
 * only the `s`/`m`/`h`/`d` units this CLI needs (KISS/YAGNI) — no external
 * dependency.
 */
function parseDurationMs(value: string): number {
  const match = /^(\d+)(s|m|h|d)$/.exec(value);
  if (!match) {
    throw new Error(
      `invalid --ttl "${value}": expected a number followed by s/m/h/d (e.g. "7d")`,
    );
  }
  const [, amount, unit] = match;
  // Regex guarantees `unit` matched one of the DURATION_UNIT_MS keys.
  const unitMs = DURATION_UNIT_MS[unit as string]!;
  return Number(amount) * unitMs;
}

/** Parsed CLI arguments: how many invites to mint, and their optional TTL. */
interface InviteCliArgs {
  count: number;
  ttlMs: number | undefined;
}

/**
 * Parse `--count <n>` (default 1) and `--ttl <duration>` (optional, omitted =
 * no expiry) out of the raw CLI args.
 */
function parseArgs(args: string[]): InviteCliArgs {
  let count = 1;
  let ttlMs: number | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--count") {
      const raw = args[i + 1];
      if (!raw) throw new Error("--count requires a value");
      count = Number(raw);
      if (!Number.isInteger(count) || count < 1) {
        throw new Error(
          `invalid --count "${raw}": expected a positive integer`,
        );
      }
      i++;
    } else if (arg === "--ttl") {
      const raw = args[i + 1];
      if (!raw) throw new Error("--ttl requires a value");
      ttlMs = parseDurationMs(raw);
      i++;
    }
  }
  return { count, ttlMs };
}

/**
 * Insert one invite row and return its plaintext code. Only the sha256 hash
 * is stored; `expiresAt` is `null` when no TTL was given.
 */
async function mintOneInvite(db: Db, expiresAt: Date | null): Promise<string> {
  const code = generateInviteCode();
  const codeHash = hashToken(code);
  await db.query`INSERT INTO invites(code_hash, expires_at) VALUES (${codeHash}, ${expiresAt})`;
  return code;
}

/**
 * Mint `--count` invites (optionally with a `--ttl`), print each plaintext
 * code to stdout (one per line), and return a process exit code. Never
 * throws — every failure (config, connection, args) is caught and reported to
 * stderr as a non-zero exit.
 */
export async function main(args: string[]): Promise<number> {
  let db: Db | undefined;
  try {
    const { count, ttlMs } = parseArgs(args);
    const config = parseConfig(process.env);
    db = createDb(config.DATABASE_URL);

    const expiresAt = ttlMs === undefined ? null : new Date(Date.now() + ttlMs);
    for (let i = 0; i < count; i++) {
      const code = await mintOneInvite(db, expiresAt);
      process.stdout.write(`${code}\n`);
    }
    return 0;
  } catch (err) {
    console.error(
      "Invite minting failed:",
      err instanceof Error ? err.message : String(err),
    );
    return 1;
  } finally {
    if (db) await db.close();
  }
}

// Guarded like `server.ts`/`worker.ts`: `main` runs only when this module is
// the process entry (tsx src/auth/invite-cli.ts), not when the test suite
// imports `main` directly.
const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? "").href;

if (isMain) {
  loadDotEnv(); // fills process.env from the repo-root .env, if present
  main(process.argv.slice(2)).then((code) => process.exit(code));
}

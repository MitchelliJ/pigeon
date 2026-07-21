/**
 * Integration tests for the invite-minting CLI (Authentication & User
 * Accounts PRD Sec. 3.1.9, FR-24, FR-25, AC-7).
 *
 * `backend/src/auth/invite-cli.ts` is expected to export a side-effect-free
 * `main(args)` — modeled on `backend/src/migrate/index.ts`'s `main()` (reads
 * `DATABASE_URL` via `parseConfig`, opens a `Db`, does one job, closes the
 * `Db`, returns an exit code, never starts the HTTP server) — that inserts N
 * `invites` rows (`--count <n>`, default 1), optionally with a TTL
 * (`--ttl <duration>`, e.g. `7d`/`1s`; omitted = no expiry), and prints the
 * plaintext codes to stdout, one per line, never persisting plaintext.
 *
 * Each test boots its own embedded Postgres cluster via `withTestDb`, points
 * `main()` at it the same way `backend/test/migrate-cli.test.ts` does (by
 * temporarily setting `process.env.DATABASE_URL`/`NODE_ENV` around the call
 * and restoring them afterward), and — where a minted code needs to be
 * exercised — mounts `authRoutes(db, mail)` and drives sign-up/verify through
 * Hono's in-process `app.request`, exactly as `signup-verify.test.ts` does.
 *
 * RED note: at authoring time `../invite-cli` does not exist — the import
 * fails and this file cannot resolve to a module. That import failure is the
 * expected RED.
 *
 * Path note: this file lives at `backend/src/auth/test/`, two levels below
 * `backend/src/`, so the harness/runner/db imports climb three levels
 * (`../../../test/db`), not two.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { withTestDb } from "../../../test/db";
import { runMigrations } from "../../migrate/runner";
import { main } from "../invite-cli";
import { authRoutes } from "../routes";
import { createMailSender } from "../../mail/index";
import { mockMail } from "../../mail/mock";
import { hashToken } from "../tokens";

const ORIGIN = "http://localhost:4321";
const JSON_HEADERS = { "content-type": "application/json", origin: ORIGIN };

/** Minimal shape of an error/status JSON response body, for `.json()` casts. */
type ErrorBody = { error?: string; code?: string; status?: string };

/** Build the mock-backed mail sender the router uses (test env, no API key). */
function mailForTest() {
  return createMailSender({
    NODE_ENV: "test" as const,
    APP_BASE_URL: ORIGIN,
    MAIL_FROM: "p@pigeon.email",
  });
}

/** Build a sign-up JSON body string. */
function signupBody(opts: {
  email: string;
  password: string;
  name: string;
  inviteCode: string;
}): string {
  return JSON.stringify({
    email: opts.email,
    password: opts.password,
    name: opts.name,
    inviteCode: opts.inviteCode,
  });
}

/** Pull the verify token T out of a captured email's html body. */
function extractToken(html: string): string {
  const m = html.match(/verify\?token=([A-Za-z0-9_-]+)/);
  if (!m) throw new Error(`no verify token in email html: ${html}`);
  return m[1]!;
}

/**
 * Drive a full sign-up + verify-email flow for one address using an
 * already-minted invite code. Asserts sign-up returns 202 and verify returns
 * 200, so the invite is genuinely consumed by the time this resolves.
 */
async function fullSignupAndVerify(
  app: ReturnType<typeof authRoutes>,
  email: string,
  password: string,
  name: string,
  inviteCode: string,
): Promise<void> {
  const res = await app.request("/api/auth/signup", {
    method: "POST",
    body: signupBody({ email, password, name, inviteCode }),
    headers: JSON_HEADERS,
  });
  expect(res.status).toBe(202);
  const html = mockMail.outbox().at(-1)?.html ?? "";
  const verifyToken = extractToken(html);
  const vres = await app.request("/api/auth/verify", {
    method: "POST",
    body: JSON.stringify({ token: verifyToken }),
    headers: JSON_HEADERS,
  });
  expect(vres.status).toBe(200);
}

/**
 * Temporarily replace `process.stdout.write` to capture everything `fn`
 * prints, restoring the real stream afterward even if `fn` throws. Returns
 * the awaited result of `fn` plus the captured output split into non-empty,
 * trimmed lines.
 */
async function captureStdout<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; lines: string[] }> {
  const originalWrite = process.stdout.write.bind(process.stdout);
  let buffer = "";
  process.stdout.write = ((chunk: unknown): boolean => {
    buffer += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  try {
    const result = await fn();
    const lines = buffer
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    return { result, lines };
  } finally {
    process.stdout.write = originalWrite;
  }
}

/**
 * Point `main()` at the given test cluster's `DATABASE_URL` for the duration
 * of `fn`, restoring the previous env vars afterward — mirrors the pattern
 * `backend/test/migrate-cli.test.ts` uses to run a `process.env`-reading CLI
 * `main()` against an embedded test cluster.
 */
async function withCliEnv<T>(
  connectionString: string,
  fn: () => Promise<T>,
): Promise<T> {
  const originalUrl = process.env.DATABASE_URL;
  const originalNodeEnv = process.env.NODE_ENV;
  const originalVaultKey = process.env.VAULT_MASTER_KEY;
  process.env.NODE_ENV = "test";
  process.env.VAULT_MASTER_KEY = "J371VUEASEUQsYjxvMKhAklLcZOslC7QAGV9/NWQTbY=";
  process.env.DATABASE_URL = connectionString;
  try {
    return await fn();
  } finally {
    if (originalUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalUrl;
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    if (originalVaultKey === undefined) delete process.env.VAULT_MASTER_KEY;
    else process.env.VAULT_MASTER_KEY = originalVaultKey;
  }
}

describe("invite CLI main()", () => {
  beforeEach(() => {
    mockMail.clear();
  });

  // FR-24/FR-25: `--count 3` inserts exactly 3 distinct-hash invite rows and
  // prints exactly 3 distinct plaintext codes, whose hashes match the rows.
  it("--count 3 inserts 3 distinct invites and prints 3 distinct plaintext codes, exiting 0", async () => {
    const { db, connectionString, close } = await withTestDb();
    try {
      await runMigrations(db);

      const { result: exitCode, lines } = await withCliEnv(
        connectionString,
        () => captureStdout(() => main(["--count", "3"])),
      );

      expect(exitCode).toBe(0);
      expect(lines).toHaveLength(3);
      expect(new Set(lines).size).toBe(3);

      const rows = await db.query`SELECT code_hash FROM invites`;
      expect(rows).toHaveLength(3);
      const printedHashes = new Set(lines.map((code) => hashToken(code)));
      const storedHashes = new Set(rows.map((r) => String(r.code_hash)));
      expect(storedHashes).toEqual(printedHashes);
    } finally {
      await close();
    }
  });

  // FR-24/FR-25/AC-7: a CLI-minted code is genuinely usable at sign-up, and
  // — once the account it signed up is verified (consuming the invite) — a
  // second sign-up attempt with the same code is rejected as bad_invite.
  it("each CLI-minted code works once at signup+verify, then 403 bad_invite on reuse", async () => {
    const { db, connectionString, close } = await withTestDb();
    try {
      await runMigrations(db);
      const mail = mailForTest();
      const app = authRoutes(db, mail);

      const { result: exitCode, lines: codes } = await withCliEnv(
        connectionString,
        () => captureStdout(() => main(["--count", "3"])),
      );
      expect(exitCode).toBe(0);
      expect(codes).toHaveLength(3);

      for (let i = 0; i < codes.length; i++) {
        const code = codes[i]!;
        await fullSignupAndVerify(
          app,
          `invitee-${i}@example.com`,
          `invite-pw-${i}-secret`,
          `Invitee ${i}`,
          code,
        );

        const reuse = await app.request("/api/auth/signup", {
          method: "POST",
          body: signupBody({
            email: `invitee-${i}-second@example.com`,
            password: `invite-pw-${i}-second`,
            name: `Invitee ${i} Second`,
            inviteCode: code,
          }),
          headers: JSON_HEADERS,
        });
        expect(reuse.status).toBe(403);
        const body = (await reuse.json()) as ErrorBody;
        expect(body.code).toBe("bad_invite");
      }
    } finally {
      await close();
    }
  });

  // FR-24: `--ttl 1s` mints a code that stops working once its short TTL has
  // genuinely elapsed.
  it("--ttl 1s mints a code that is rejected as bad_invite once expired", async () => {
    const { db, connectionString, close } = await withTestDb();
    try {
      await runMigrations(db);
      const mail = mailForTest();
      const app = authRoutes(db, mail);

      const { result: exitCode, lines } = await withCliEnv(
        connectionString,
        () => captureStdout(() => main(["--ttl", "1s"])),
      );
      expect(exitCode).toBe(0);
      expect(lines).toHaveLength(1);
      const code = lines[0]!;

      // Genuinely short, deterministic wait past the 1s TTL — unlike the
      // 30/90/60-day windows elsewhere in this project, which are backdated
      // via SQL instead of slept through.
      await new Promise((resolve) => setTimeout(resolve, 1100));

      const res = await app.request("/api/auth/signup", {
        method: "POST",
        body: signupBody({
          email: "expired-invite@example.com",
          password: "expired-pw-secret1",
          name: "Expired Invite",
          inviteCode: code,
        }),
        headers: JSON_HEADERS,
      });
      expect(res.status).toBe(403);
      const body = (await res.json()) as ErrorBody;
      expect(body.code).toBe("bad_invite");
    } finally {
      await close();
    }
  });

  // FR-24: the CLI is a one-shot job, not a server — `main` must resolve on
  // its own without ever binding an HTTP port. No `serve()` call means no
  // `server.close()` is needed to clean up here, unlike `server.ts`'s tests.
  it("main resolves on its own without starting an HTTP server", async () => {
    const { db, connectionString, close } = await withTestDb();
    try {
      await runMigrations(db);

      const { result: exitCode } = await withCliEnv(connectionString, () =>
        captureStdout(() => main(["--count", "1"])),
      );

      expect(exitCode).toBe(0);
      // No server.close() call anywhere in this test — main() is expected to
      // exit on its own with nothing left listening.
    } finally {
      await close();
    }
  });
});

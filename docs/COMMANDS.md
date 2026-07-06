# Commands

Frequently-used commands for the Pigeon monorepo. Run from the repo root
unless noted. Requires Node 22 (`nvm use`) and pnpm 10 (≥ 10.16).

See `LOCAL_SETUP.md` for first-time local setup and `DEPLOY_TO_HETZNER.md` for
the single-Hetzner-box production runbook.

# Development

Launch all three local-dev processes (Postgres, frontend+API, worker) at
once, each in its own terminal (Windows Terminal tab if `wt.exe` is
installed, otherwise a separate PowerShell window each):
`pnpm dev:all`

Or run them individually, in separate terminals:

Local Postgres (no Docker — persists to `.pgdata/`, git-ignored):
`pnpm dev:db`

Frontend (Astro, http://localhost:4321) and backend API
(Hono, http://localhost:8788) together, with hot reload:
`pnpm dev`

Background worker:
`pnpm dev:worker`

Individual processes:
`pnpm dev:frontend` · `pnpm dev:backend`

# Check (lint + typecheck + unit tests)

Full local gate before pushing — ESLint, all workspace typechecks, and the
Vitest suite:
`pnpm check:all`

# Lint & Typecheck (phase gate)

Static checks only (no tests). This is the gate the `go` skill runs after each
parent task:
`pnpm check`

# Migrations

Apply all forward-only `db/migrations/NNNN_name.sql` files idempotently,
tracked in the `schema_migrations` table, each in its own transaction:
`pnpm migrate`

Re-running is a no-op: already-applied files are skipped. An applied
migration id higher than anything on disk is rejected (an out-of-order
guard — see `backend/src/migrate/runner.ts`). There are no down-migrations;
rollbacks are constrained to restoring the `pgdata` volume from a backup or
forward-fixing with a new corrective migration (see `DEPLOY_TO_HETZNER.md`).

`pnpm migrate` runs `backend/src/migrate/cli.ts`, which reads `DATABASE_URL`
from the environment (validated via `backend/src/config`). In development
`DATABASE_URL` defaults to the docker-compose value, so you can run it
against a composed Postgres or any reachable engine.

# Invites

Sign-up is invite-only unless `SIGNUP_OPEN=true`. Mint one or more invite
codes (printed to stdout once, in plaintext — only their hash is persisted):
`pnpm invite`

Mint several at once, optionally with a TTL (`s`/`m`/`h`/`d`; omit `--ttl` for
codes that never expire):
`pnpm invite --count 5 --ttl 7d`

`pnpm invite` runs `backend/src/auth/invite-cli.ts`, which reads
`DATABASE_URL` from the environment (validated via `backend/src/config`), same
as `pnpm migrate`.

# Mail in development

Without a `RESEND_API_KEY` set, `NODE_ENV=development` and `NODE_ENV=test`
both fall back to an in-process mock mail provider instead of calling Resend.
Verification and password-reset emails are logged to stdout at
`LOG_LEVEL=info` as a subject line plus a clickable link, so you can complete
the sign-up / reset flow locally without a real Resend account:
`[mail:mock] to=you@example.com subject="Verify your email" link=http://localhost:4321/verify?token=...`

Set `RESEND_API_KEY` (and `MAIL_FROM`, `APP_BASE_URL`) to send through Resend
instead, even outside production.

# Tests

`pnpm test` (vitest) — integration suites boot a **real embedded Postgres**
per test case via `backend/test/db.ts` (no Docker, no service container).
Each boot takes roughly **15-18 seconds**, and the Vitest config runs all
test files sequentially in one fork (`poolOptions.forks.singleFork`) so
clusters never start concurrently. That makes the full suite slow
(~15 minutes) — fine for a pre-push gate, too slow to run after every TDD
step.

`pnpm test` is also where migrations run on CI: `migrate.test.ts` and
`migrate-cli.test.ts` exercise the runner and the `pnpm migrate` CLI's `main()`
against the embedded engine.

## Targeted runs (use these during TDD, not `pnpm test`)

Run a single file — pays for only that file's cluster boots:
`pnpm exec vitest run <path>`
e.g. `pnpm exec vitest run backend/src/auth/test/signup-verify.test.ts`

Run a single test by name within a file — pays for exactly one cluster boot
(~15-18s), the cheapest way to confirm one RED/GREEN case:
`pnpm exec vitest run <path> -t "<test name>"`
e.g. `pnpm exec vitest run backend/test/readyz.test.ts -t "healthz stays 200"`

**When to use which:**

- **CONFIRM RED / CONFIRM GREEN** (single task): target the one test by name.
- **REFACTOR** (behavior-preserving change across a task): run the file.
- **CHECK PHASE / pre-push gate**: run the full `pnpm test` — this is the only
  point that needs every test file, so it's the only point that should pay
  the full ~15 minutes.

# Other

Auto-fix lint issues:
`pnpm lint:fix`

Format the whole repo with Prettier:
`pnpm format`

Check formatting without writing:
`pnpm format:check`

Typecheck every workspace:
`pnpm typecheck`

Run the test suite once:
`pnpm test`

Build the frontend for production:
`pnpm build` · preview it: `pnpm preview`

Build & run the full stack in containers (Postgres + API + worker):
`docker compose up --build`

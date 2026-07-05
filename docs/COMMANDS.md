# Commands

Frequently-used commands for the Pigeon monorepo. Run from the repo root
unless noted. Requires Node 22 (`nvm use`) and pnpm 10 (≥ 10.16).

See `SETUP.md` for first-time local setup and `DEPLOY.md` for the
single-Hetzner-box production runbook.

# Development

Start the frontend (Astro, http://localhost:4321) and backend API
(Hono, http://localhost:8788) together, with hot reload:
`pnpm dev`

Run the background worker (separate terminal):
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
forward-fixing with a new corrective migration (see `DEPLOY.md`).

`pnpm migrate` runs `backend/src/migrate/cli.ts`, which reads `DATABASE_URL`
from the environment (validated via `backend/src/config`). In development
`DATABASE_URL` defaults to the docker-compose value, so you can run it
against a composed Postgres or any reachable engine.

# Tests

`pnpm test` (vitest) — integration suites boot a **real embedded Postgres**
per test file via `backend/test/db.ts` (no Docker, no service container).
The Vitest config runs all test files sequentially in one fork
(`poolOptions.forks.singleFork`) so clusters never start concurrently.
`
pnpm test` is also where migrations run on CI: `migrate.test.ts` and
`migrate-cli.test.ts` exercise the runner and the `pnpm migrate` CLI's `main()`
against the embedded engine.

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

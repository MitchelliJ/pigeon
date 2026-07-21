# Commands

Canonical command contract for the Pigeon monorepo — the single source of
truth the `go` skill resolves against. Run from the repo root unless noted.
Requires Node 22 (`nvm use`) and pnpm 10 (≥ 10.16). See `docs/LOCAL_SETUP.md`
for first-time local setup and `deploy/hetzner.md` for the production runbook.

Phase gate (after each parent task) is `pnpm check` — static checks plus the
fast unit project. The complete pre-push / final gate is `pnpm validate`.

# Development

Launch all three local-dev processes (Postgres, frontend+API, worker), each in
its own terminal:
`pnpm dev:all`

Frontend (Astro, http://localhost:4321) + backend API (Hono,
http://localhost:8788) together, with hot reload:
`pnpm dev`

Individually: `pnpm dev:db` (local Postgres, persists to `.pgdata/`) ·
`pnpm dev:worker` (background worker) · `pnpm dev:frontend` · `pnpm dev:backend`

# Unit tests

Pure-logic `*.test.ts` in the `unit` Vitest project. Never boot infrastructure,
run in parallel, finish in seconds — safe to run after every TDD step.

Run all unit tests:
`pnpm test:unit`

Run one selected unit test:
`pnpm exec vitest run --project unit <path> -t "<test name>"`
e.g. `pnpm exec vitest run --project unit backend/test/config.test.ts -t "rejects a missing DATABASE_URL"`

# Integration tests

`*.integration.test.ts` and `*.e2e.test.ts` in the `integration` Vitest
project. Each boots a **real embedded Postgres** via `backend/test/db.ts` (no
Docker, no service container) — roughly 15-18s per file. The project runs every
file in a single fork (`poolOptions.forks.singleFork`) so clusters never start
concurrently; the full project is slow (~15 min), so run targeted files during
TDD and the whole project only at the phase/final gate. Migrations are also
exercised here (`migrate.integration.test.ts`, `migrate-cli.integration.test.ts`).

Run all integration tests:
`pnpm test:integration`

Run one selected integration test:
`pnpm exec vitest run --project integration <path> -t "<test name>"`
e.g. `pnpm exec vitest run --project integration backend/test/readyz.integration.test.ts -t "/healthz stays 200 regardless of DB"`

# Static checks

ESLint (correctness) + all workspace typechecks. No tests. This is the static
half of the phase gate:
`pnpm check:static`

# Complete validation

Static checks + all unit tests + all integration/e2e tests + the frontend
production build. This is the full pre-push gate and the final task's gate:
`pnpm validate`

Phase gate only (static checks + unit project — run after each parent task):
`pnpm check`

# Other

Apply forward-only `db/migrations/NNNN_name.sql` files idempotently:
`pnpm migrate`

Mint invite codes (printed once to stdout; only the hash is persisted):
`pnpm invite` · with options: `pnpm invite --count 5 --ttl 7d`

Formatting and lint fixes:
`pnpm format` · `pnpm format:check` · `pnpm lint:fix`

Build / preview the frontend:
`pnpm build` · `pnpm preview`

Build & run the full stack in containers (Postgres + API + worker):
`docker compose up --build`

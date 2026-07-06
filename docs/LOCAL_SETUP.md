# Local setup

Getting Pigeon running on your machine for development.

## Prerequisites

- **Node 22** — `nvm use` (see `.nvmrc`).
- **pnpm 10** (≥ 10.16) — `corepack enable && corepack prepare pnpm@10.16.0 --activate`.
- **Docker** — _not required._ `pnpm dev:db` (below) gives you a local
  Postgres with no Docker daemon at all. Docker is only relevant if you want
  to run the full containerized stack (Postgres + API + worker) for
  production parity; see `DEPLOY_TO_HETZNER.md`.

## Install

```sh
pnpm install
```

`pnpm install` approves and runs the `embedded-postgres` platform-binary
postinstall (declared in `pnpm-workspace.yaml` under `onlyBuiltDependencies`).
That package ships real Postgres binaries that both the integration tests and
`pnpm dev:db` (below) boot directly — no Docker daemon, no service container,
no admin. If pnpm ever warns that build scripts were ignored, run `pnpm
rebuild` (or `pnpm approve-builds` interactively) so the binaries hydrate.

## Environment

```sh
cp .env.example .env
```

`.env.example` documents every key `backend/src/config/index.ts` validates,
with dev-friendly defaults commented out — see it for the current full list
(it grows as features land, so it's the source of truth, not this doc).
`VAULT_MASTER_KEY` is the one key **required in every environment, including
development** — generate one with the one-liner in `.env.example`.
`DATABASE_URL` is _not_ required in development — when absent, the backend
falls back to `postgres://pigeon:pigeon@localhost:5432/pigeon`, which is
exactly what `pnpm dev:db` (below) listens on. `NODE_ENV=production|test`
_does_ require `DATABASE_URL`.

`.env` is read automatically at startup by `pnpm dev`/`dev:worker`/`migrate`/
`invite` (a small hand-rolled loader, `backend/src/env.ts` — no `dotenv`
dependency) — it only fills in variables not already set in your shell, so a
real exported env var always wins. No need to `export` anything by hand for
local dev.

`.env.old` at the repo root is a **reference of future-feature keys**
(Mistral, Mollie, Discord, OAuth, …). It is not read at runtime; leave it
alone.

## Local Postgres (no Docker)

```sh
pnpm dev:db
```

Boots a persistent embedded Postgres cluster (same `embedded-postgres`
package the test harness uses, but long-lived instead of throwaway) listening
on `postgres://pigeon:pigeon@localhost:5432/pigeon` — the exact default
`DATABASE_URL` falls back to, so nothing else needs configuring. Data lives
in `.pgdata/` at the repo root (git-ignored); Ctrl+C stops the cluster and
leaves the data in place for next time. Run this in its own terminal,
alongside `pnpm dev` and `pnpm dev:worker` below.

Prefer Docker instead? `docker compose up -d db` brings up just the Postgres
container from `docker-compose.yml` (no need to build the app images for
local dev) — see `DEPLOY_TO_HETZNER.md` for the full containerized stack.

## Running the app

```sh
pnpm dev:db       # local Postgres (separate terminal, see above)
pnpm dev          # frontend (Astro, :4321) + backend API (Hono, :8788) together
pnpm dev:worker   # background worker (separate terminal)
```

`pnpm migrate` needs to be run once against a fresh database (see
Migrations, below) before `pnpm dev`/`dev:worker` will work end-to-end.

The worker runs three independent loops: a liveness heartbeat, a scheduler
tick that enqueues due mailboxes for sync, and a poll loop that claims and
runs queued jobs (Job Queue, Workers & Scheduler PRD) — its terminal is where
you'll see sync activity for a connected mailbox.

Individual processes: `pnpm dev:frontend`, `pnpm dev:backend`.

## Health

```sh
curl http://localhost:8788/healthz   # liveness  → {"ok":true}
curl http://localhost:8788/readyz     # readiness → 200 {"ok":true} when the DB is reachable,
                                      #             → 503 {"ok":false,"reason":"…"} when it isn't
```

## Migrations

```sh
pnpm migrate       # apply forward-only db/migrations/*.sql idempotently
```

Re-running is a no-op: already-applied files are skipped; out-of-order state
(an applied migration id higher than anything on disk) is rejected.
Migrations are plain `NNNN_name.sql` files under `db/migrations/`, tracked in
the `schema_migrations` table, each applied in its own transaction.

## Tests

```sh
pnpm test          # vitest — integration suites boot a real embedded Postgres
pnpm check:all     # lint + typecheck + tests (the full local gate before pushing)
pnpm check         # lint + typecheck only (phase gate)
```

No Docker / no service needed — the embedded Postgres harness in
`backend/test/db.ts` starts a fresh, isolated cluster per test file
(because it can, and because it keeps state clean). The Vitest config runs all
test files in a single forked process sequentially (`poolOptions.forks.singleFork`)
so clusters never start concurrently; this is deliberate — concurrent cluster
boots flap on some hosts.

## Containerized stack (optional, Docker)

```sh
docker compose up --build
```

Brings up Postgres, runs migrations once as a `migrate` one-shot service, then
starts the API and worker. Stop with `docker compose down` (add `-v` to wipe
the `pgdata` volume too). See `DEPLOY_TO_HETZNER.md` for the production
runbook.

## Troubleshooting

- **`tsx … MODULE_NOT_FOUND` inside Docker** — you hit the pre-feature-1
  `.dockerignore` bug; it's fixed now, but if you reintroduce a bare
  `COPY backend ./backend` without excluding `node_modules`, the host's pnpm
  symlinks will clobber the in-image install. Keep `node_modules` ignored.
- **`embedded-postgres` won't boot** — confirm its platform binary postinstall
  ran (`pnpm rebuild`), and that `@embedded-postgres/<your-platform>` is in
  `pnpm-workspace.yaml`'s `onlyBuiltDependencies`.
- **`pnpm check` linting errors** — run `pnpm lint:fix` and `pnpm format`.

# Local setup

Getting Pigeon running on your machine for development.

## Prerequisites

- **Node 22** — `nvm use` (see `.nvmrc`).
- **pnpm 10** (≥ 10.16) — `corepack enable && corepack prepare pnpm@10.16.0 --activate`.
- **Docker** (optional) — only needed to run the full containerized stack
  (Postgres + API + worker); see `DEPLOY.md`. Unit/integration tests do **not**
  require Docker.

## Install

```sh
pnpm install
```

`pnpm install` approves and runs the `embedded-postgres` platform-binary
postinstall (declared in `pnpm-workspace.yaml` under `onlyBuiltDependencies`).
That package ships real Postgres binaries that the integration tests boot
directly — no Docker daemon, no service container, no admin. If pnpm ever
warns that build scripts were ignored, run `pnpm rebuild` (or `pnpm
approve-builds` interactively) so the binaries hydrate.

## Environment

```sh
cp .env.example .env
```

`.env.example` lists only the keys the baseline validates today (`PORT`,
`WORKER_HEARTBEAT_INTERVAL_MS`). `DATABASE_URL` is **not** required in
development — when absent, the backend falls back to
`postgres://pigeon:pigeon@localhost:5432/pigeon` (the value used by
`docker compose`). `NODE_ENV=production|test` _does_ require `DATABASE_URL`.

`.env.old` at the repo root is a **reference of future-feature keys**
(Mistral, Mollie, Discord, vault, OAuth, …). It is not read at runtime; leave
it alone.

## Running the app

```sh
pnpm dev          # frontend (Astro, :4321) + backend API (Hono, :8788) together
pnpm dev:worker   # background worker (separate terminal)
```

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
the `pgdata` volume too). See `DEPLOY.md` for the production runbook.

## Troubleshooting

- **`tsx … MODULE_NOT_FOUND` inside Docker** — you hit the pre-feature-1
  `.dockerignore` bug; it's fixed now, but if you reintroduce a bare
  `COPY backend ./backend` without excluding `node_modules`, the host's pnpm
  symlinks will clobber the in-image install. Keep `node_modules` ignored.
- **`embedded-postgres` won't boot** — confirm its platform binary postinstall
  ran (`pnpm rebuild`), and that `@embedded-postgres/<your-platform>` is in
  `pnpm-workspace.yaml`'s `onlyBuiltDependencies`.
- **`pnpm check` linting errors** — run `pnpm lint:fix` and `pnpm format`.

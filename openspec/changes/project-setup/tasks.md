## 1. Workspace scaffolding

- [ ] 1.1 Create `apps/server`, `apps/worker`, `packages/config`, `packages/db` directories with `package.json` (private, ESM, `@pigeon/*` names) and per-package `tsconfig.json` extending `tsconfig.base.json`
- [ ] 1.2 Update `pnpm-workspace.yaml` (if needed) and root `package.json` scripts (`dev:server`, `dev:worker`, `migrate`, `lint`, `typecheck`, `build`) to include the new packages
- [ ] 1.3 Lock tooling choices: config-validation library and migration tool; add dependencies respecting the `minimumReleaseAge` cooldown
- [ ] 1.4 Verify `pnpm install` succeeds and all workspace packages resolve

## 2. Configuration package (`packages/config`)

- [ ] 2.1 Define a typed environment schema (host, port, database URL, worker heartbeat interval, log level) and parse `process.env` through it
- [ ] 2.2 Export a frozen, typed config object; throw on missing/invalid values identifying the offending variable
- [ ] 2.3 Add a config-summary logger that redacts/omits secret values
- [ ] 2.4 Add a committed `.env.example` listing every variable with placeholder values; ensure real `.env` is gitignored
- [ ] 2.5 Verify: valid env loads, invalid/missing env fails fast, secrets are not logged

## 3. Database package (`packages/db`)

- [ ] 3.1 Implement a `pg` connection pool configured from `packages/config`, with fast-fail on unreachable database and a connectivity check helper
- [ ] 3.2 Wire the chosen migration tool with a bookkeeping table; expose a CLI-invokable migrate command (root `migrate` script)
- [ ] 3.3 Add the baseline migration (bookkeeping/setup only, no domain tables)
- [ ] 3.4 Verify: migrations apply to an empty DB, re-running is idempotent, connectivity helper succeeds against a running Postgres

## 4. Backend service (`apps/server`)

- [ ] 4.1 Create a Hono + `@hono/node-server` entrypoint that loads config and binds to the configured host/port; exit non-zero on invalid config
- [ ] 4.2 Add a liveness/health endpoint returning 200 + JSON status
- [ ] 4.3 Add a readiness endpoint that returns 200 when the DB is reachable and 503 when it is not (using `packages/db`)
- [ ] 4.4 Implement graceful shutdown on SIGTERM/SIGINT (stop accepting connections, release DB pool, exit 0)
- [ ] 4.5 Verify: service starts, health and readiness behave as specified, graceful shutdown works

## 5. Worker runtime (`apps/worker`)

- [ ] 5.1 Create a worker entrypoint that loads config, establishes a DB connection, and logs running state; exit non-zero on invalid config
- [ ] 5.2 Implement a periodic heartbeat/liveness signal at the configured interval (no jobs)
- [ ] 5.3 Implement graceful shutdown on SIGTERM/SIGINT (stop loop, release DB pool, exit 0)
- [ ] 5.4 Verify: worker starts, heartbeats, and shuts down cleanly

## 6. Containerization & local stack

- [ ] 6.1 Add multi-stage Dockerfiles for `apps/server` and `apps/worker` (build → slim runtime) consuming env at runtime
- [ ] 6.2 Add `docker-compose.yml` running Postgres + server + worker wired with dev config and a `.env`
- [ ] 6.3 Verify: images build, containers pass health/liveness, full compose stack starts and backend readiness is healthy
- [ ] 6.4 Verify: migrations run successfully against the compose Postgres

## 7. CI pipeline

- [ ] 7.1 Add a GitHub Actions workflow triggered on push and pull request: pnpm install (respecting cooldown), lint, typecheck, build
- [ ] 7.2 Add a CI step running migrations against an ephemeral/service-container Postgres
- [ ] 7.3 Add a CI step building the server and worker container images
- [ ] 7.4 Verify: CI passes on a clean PR and fails on an introduced type error

## 8. Hetzner deployment

- [ ] 8.1 Choose a container registry and publish server/worker images from CI (or a documented manual step)
- [ ] 8.2 Provision a Hetzner host and document the repeatable deploy of the compose stack (Postgres + services) with host-supplied secrets
- [ ] 8.3 Document image-version rollback and Postgres backup/restore
- [ ] 8.4 Verify: services run on the Hetzner host connected to Postgres and the backend health endpoint is reachable

## 9. Documentation

- [ ] 9.1 Update `README.md` with the new monorepo layout, local stack startup, migration commands, and deployment overview

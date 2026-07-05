# PRD — 1. Project Initialization & Infrastructure Baseline

> Stand up the backend and worker runtime in the monorepo with database,
> migrations, config/secret loading, containerized local + Hetzner deployment,
> and CI — **no business logic**. Every later feature mounts onto this baseline.

---

## 1. Introduction / Overview

This is the walking-skeleton foundation: the smallest correct explorable
instance of Pigeon that every subsequent feature (auth, inbox connectors, sync,
LLM, delivery, billing, …) attaches to. It wires the **Postgres 17** database
into the existing Hono API + worker runtime, adds a **migration runner** and the
first forward-only migrations, introduces a **validated config layer** that
crashes the process on bad env, builds an **embedded-Postgres test harness** so
integration tests run against the real engine, and closes the gaps the
restructure left open (CI migrate step, compose migrate-on-boot, `DEPLOY.md`/`SETUP.md`,
real `/readyz`). No product behavior is built.

The deliverable is: `pnpm install` → `pnpm check:all` (green, with at least one
integration test booting embedded Postgres and applying migrations) →
`docker compose up --build` (Postgres + API + worker, API `/readyz` reports the
DB is reachable) → CI runs identically including a migrations step.

**Problem solved:** today the runtime is a no-DB scaffold. `DATABASE_URL` is
plumbed through compose but never opened; there is no migration runner; config
is read ad-hoc via `process.env` with no validation; the test harness the
guidelines mandate doesn't exist yet; CI and compose both carry a _"migrate step
re-added in feature 1"_ TODO; and the deployment runbooks (`DEPLOY.md`,
`SETUP.md`) that `deploy/hetzner.md` links to don't exist. Feature 1 closes all
of these and nothing more.

---

## 2. User Stories

- **As a developer**, I want `pnpm check:all` to boot a real (embedded) Postgres,
  run our migrations against it, and exercise our SQL, so that integration bugs
  show up locally before CI.
- **As a developer**, I want a single `pnpm migrate` command that applies all
  forward-only `NNNN_name.sql` files idempotently, so I can reset any environment
  (dev, test, prod) the same way.
- **As a developer**, I want the process to refuse to start when an env var is
  missing or malformed, naming the exact variable, so misconfig never silently
  runs half-broken.
- **As an operator**, I want `docker compose up --build` to bring up Postgres,
  run migrations as a one-shot step, then start the API and worker — so a single
  command yields a healthy stack with the DB reachable.
- **As an operator**, I want CI to run migrations as an explicit step (mirroring
  prod) so that a migration that breaks on a fresh DB fails the build, not prod.
- **As an operator**, I want `GET /readyz` to actually probe the database, so a
  load balancer/healthcheck never routes traffic to an instance whose DB is
  gone.
- **As a developer**, I want the deployment runbooks referenced by
  `deploy/hetzner.md` (`DEPLOY.md`, `SETUP.md`) to exist and be accurate, so
  onboarding and provisioning aren't dead links.

---

## 3. Functional Requirements

### 3.1 Database module (`backend/src/db/`)

- **FR-1.** A `backend/src/db/` module owns the connection: a `postgres.js`
  (`postgres` package, porsager) client/pool constructed from validated config.
- **FR-2.** Exports a `query` (tagged-template) helper and a `withTx(fn)` helper
  that runs `fn` inside `BEGIN…COMMIT`, rolling back on error. Retries only on
  serialization/deadlock errors (`40P01`), up to a small bounded count.
- **FR-3.** The client is created once at startup and closed on `SIGINT`/`SIGTERM`
  as part of graceful shutdown (extend the existing `shutdown` path in both
  `server.ts` and `worker.ts`).
- **FR-4.** Node-postgres env (`PGHOST`/`PGPORT`/etc.) is **not** used; all
  connection params come from a single `DATABASE_URL` parsed by the config layer.

### 3.2 Migration runner (`backend/src/migrate/`) + migrations (`db/migrations/`)

- **FR-5.** A bespoke forward-only runner. Reads `db/migrations/*.sql`, sorts by
  the literal `NNNN_` numeric prefix, and applies each unapplied file in order.
- **FR-6.** Tracks applied migrations in a `schema_migrations` table
  (`id BIGINT PRIMARY KEY` = the `NNNN` number, `filename TEXT NOT NULL`,
  `applied_at TIMESTAMPTZ NOT NULL DEFAULT now()`). Created by the very first
  migration `0001_schema_migrations.sql`.
- **FR-7.** Each migration runs inside its own transaction; on failure the
  transaction rolls back and the runner aborts with a non-zero exit, leaving
  prior applied migrations intact.
- **FR-8.** The runner is **idempotent**: re-running skips already-applied files;
  it is an error for a file present on disk to be missing from the applied set
  out of order (gaps allowed, but an applied `id` must never exceed the max on
  disk — guards against a partial prod rollforward then rollback-to-old-image).
- **FR-9.** Exposes `pnpm migrate` (root) / `pnpm --filter @pigeon/backend migrate`
  which runs the runner against `DATABASE_URL`.
- **FR-10.** Initial migrations this feature ships (no business logic):
  - `0001_schema_migrations.sql` — the tracking table above.
  - `0002_health.sql` — a tiny `health` table (one row, one `checked_at`
    column) the `/readyz` probe writes, so readiness touches a real writable
    relation.
  - **No `users`/`sessions`/`accounts`/`channels` tables** — those land with
    their owning features (Feature 2+).

### 3.3 Config module (`backend/src/config/`)

- **FR-11.** A Zod schema validating the env Pigeon needs _today_:
  - `NODE_ENV` (enum: `development|test|production`, default `development`).
  - `PORT` (number, default `8788`).
  - `DATABASE_URL` (**required** in `production` and `test`; in `development`
    defaults to the docker-compose value when absent).
  - `LOG_LEVEL` (enum: `trace|debug|info|warn|error`, default `info`).
  - `WORKER_HEARTBEAT_INTERVAL_MS` (number, default `30000`).
  - `HOST` (string, default `0.0.0.0`).
- **FR-12.** Validation runs once at startup (both entry points). On failure the
  process prints the offending variable's name and the Zod message to stderr and
  exits non-zero _before_ opening the DB or binding the server.
- **FR-13.** Exposes a typed `config` object and a redacting `describeConfig()`
  that prints booleans only ("DATABASE_URL: set", never the value). Secrets are
  never echoed, even in error messages.
- **FR-14.** Future feature keys (`MISTRAL_API_KEY`, `MOLLIE_API_KEY`,
  `VAULT_KEY`, `DISCORD_WEBHOOK_URL`, OAuth secrets, …) are **not** required by
  this schema and are **not** added to `.env.example`; they land with their
  owning features. The config module must be trivially extensible (one new Zod
  field) when they arrive.

### 3.4 `/readyz` becomes real

- **FR-15.** `GET /readyz` runs a lightweight DB probe (`INSERT INTO
health(checked_at) VALUES (now())` on a single-row table, or an equivalent
  writable check) and returns `{ ok: true }` / 200 on success, `{ ok: false,
reason }` / 503 on failure. `GET /healthz` stays as-is (process-up only).

### 3.5 Test harness (`backend/test/db.ts`)

- **FR-16.** A shared helper that spins up an **embedded Postgres** (real
  binaries via npm, e.g. `embedded-postgres`) on a random free port with a temp
  data dir, applies the migrations _through the same runner_ (FR-5), and returns
  a `postgres.js` client plus a `close()` that drops the cluster.
- **FR-17.** One isolated cluster **per test file** (`describe` block scopes it);
  tests do not share a database. Cluster binary cached on disk after first run.
- **FR-18.** No `pg`/`postgres`-as-CI-service dependency — tests need nothing
  beyond `pnpm install`.
- **FR-19.** At least one real integration test ships: it boots the harness,
  asserts `schema_migrations` exists with rows `0001` and `0002`, asserts the
  `health` table is writable, and tears down.

### 3.6 Containerized local + Hetzner deployment

- **FR-20.** `docker-compose.yml` gains a **one-shot `migrate` step**: the
  `server` container's `command` becomes a tiny shell that runs `pnpm migrate`
  then `pnpm start` (or a dedicated `migrate` container that the API/worker
  `depends_on` with `condition: service_completed_successfully`). The exact
  mechanism is an implementation decision in create-tasks, but compose must
  never start serving until migrations have applied.
- **FR-21.** `backend/Dockerfile` already exists and builds both processes from
  one image; this feature ensures the `db/migrations` directory is copied into
  the image (currently it isn't referenced) so `pnpm migrate` works in-container.
- **FR-22.** Write the repo-root **`DEPLOY.md`** (Hetzner provisioning: server
  sizing, Docker install, clone, `.env`, `docker compose up --build`, Caddy/TLS,
  backups of the `pgdata` volume, update/rollback via image rebuild + migrate
  step) and **`SETUP.md`** (local developer onboarding: `pnpm install`,
  `.env` copy, `pnpm dev` / `pnpm dev:worker`, running tests with embedded
  Postgres, `pnpm check:all`). These are the files `deploy/hetzner.md` links to.

### 3.7 CI

- **FR-23.** `.github/workflows/ci.yml` `checks` job gains an explicit
  **`pnpm migrate`** step right after install and before tests, pointed at a
  throwaway Postgres (use the embedded harness — same path tests use — so CI
  needs no `services:` block). Alternatively run `pnpm test` first and let the
  harness cover migrations; the chosen ordering is a create-tasks decision, but
  migrations must execute on CI.
- **FR-24.** CI stays green: `pnpm lint` → `pnpm typecheck` → `pnpm test`
  (embedded Postgres) → `pnpm build` → image build. The existing image-build job
  is unaffected.

### 3.8 Environmental & docs

- **FR-25.** `.env.example` stays minimal: only the keys validated today
  (FR-13). The existing `.env.old` is left untouched (it remains the reference
  for future-feature keys).
- **FR-26.** `docs/COMMANDS.md` documents `pnpm migrate` and the embedded-
  Postgres test story.

---

## 4. Technical Requirements

- **Language/runtime:** TypeScript, ESM, Node 22, run via `tsx` (no build step).
  Strict, `noUncheckedIndexedAccess` on (already in `tsconfig.base.json`).
- **Driver:** `postgres` (porsager's `postgres.js`) — tagged-template queries,
  a `Pool` over a single `DATABASE_URL`. `pg` is **not** introduced.
- **Embedded Postgres:** `embedded-postgres` (or an equivalent npm package
  shipping real binaries) chosen so the V8-test path uses the genuine engine
  with zero Docker/admin. Must run on Linux CI runners and local dev shells.
- **Migrations:** plain `.sql` files under repo-root `db/migrations/`, named
  `NNNN_short_name.sql` (`NNNN` zero-padded to 4, e.g. `0001_schema_migrations.sql`).
  Forward-only; no down-migrations. Each file is a single SQL script; the runner
  wraps it in a transaction.
- **No new workspaces:** only `frontend`, `backend`, `shared`. The `db/`
  directory is plain files, not a workspace package.
- **No new external services in compose:** still just Postgres + API + worker.
  No Redis/RabbitMQ; the future job queue rides on the same Postgres (Feature 5).
- **Graceful shutdown:** both `server.ts` and `worker.ts` close the DB pool and
  the HTTP server / heartbeat timer on `SIGINT`/`SIGTERM`, exiting 0.
- **Config validation:** Zod schemas, parsed once at import of `config/`. Read
  `process.env` only inside the config module; everywhere else consumes the
  typed object (so the process truly cannot run with bad config).
- **Module-doc convention:** every new module starts with a block comment stating
  what it does and why (per coding guidelines §3).
- **Conventional Commits:** PRs use `feat:`, `chore:` etc.; `fe infra`-style
  commits land on `main`.

---

## 5. Acceptance Criteria

1. **AC-1.** `pnpm check:all` is green and the suite includes at least one
   integration test that boots embedded Postgres, applies migrations through the
   runner, and verifies `schema_migrations` + `health` — without any
   `services:`/Docker dependency in CI or locally.
2. **AC-2.** `pnpm migrate` is idempotent: running it twice in a row applies
   zero migrations the second time and exits 0; it cleanly creates
   `schema_migrations` and `health` on a fresh DB.
3. **AC-3.** Starting the API with a missing/malformed `DATABASE_URL` in
   `NODE_ENV=production` exits non-zero with a stderr message naming the
   variable; it never binds the port or opens the pool.
4. **AC-4.** `GET /readyz` returns 503 `{ ok:false, reason:"…" }` when the DB is
   unreachable, and 200 `{ ok:true }` when it is (verified by an integration
   test that points `/readyz` at a real embedded cluster, then stops the
   cluster).
5. **AC-5.** `docker compose up --build` brings the stack to a healthy state:
   Postgres starts, migrations run once (no double-apply on a second `up`),
   `/readyz` is 200 on the bound port, the worker prints heartbeats. Stopping
   with `docker compose down` exits cleanly.
6. **AC-6.** CI runs the full pipeline including the migrations step and is
   green on `main`.
7. **AC-7.** `DEPLOY.md` and `SETUP.md` exist at the repo root, are referenced
   correctly by `deploy/hetzner.md`, and a developer following `SETUP.md` cold
   can get to `pnpm check:all` green and `docker compose up` healthy.
8. **AC-8.** No business tables (`users`, `sessions`, `accounts`, `channels`…)
   exist yet; no vault/crypto code exists; no integration secrets appear in
   `.env.example` or logs.
9. **AC-9.** `pnpm lint` and `pnpm typecheck` are green with no `any`-typed
   escape hatches in the new modules.

---

## 6. Open Questions

- **OQ1.** Should `docker compose up` run migrations via a dedicated
  one-shot `migrate` container (`depends_on: service_completed_successfully`)
  or by prepending `pnpm migrate &&` to the `server` container's `command`?
  The dedicated-container pattern is cleaner and lets the worker start only
  once the schema is ready; the prepend pattern is fewer moving parts. Defer the
  exact mechanism to create-tasks.
- **OQ2.** The brief calls for a Hetzner deployment to be exercised end-to-end.
  Is an actual Hetzner provision in scope for _acceptance_ of this feature, or
  is the `DEPLOY.md` runbook + local `docker compose` parity sufficient as the
  acceptance signal (with real Hetzner rollout being the first task of Feature 2
  / a separate ops task)?

---

## 7. Non-Goals (Out of Scope)

- **No business logic or product tables.** No `users`, `sessions`, `accounts`,
  `mailboxes`, `channels`, `emails`, `jobs`, `subscriptions` tables — each lands
  with its owning feature.
- **No authentication/sessions.** `requireAuth`, scrypt hashing, cookies, and
  the `users`/`sessions` schema are Feature 2.
- **No `vault` / encryption-at-rest module.** AES-256-GCM lands with Feature 3
  (inbox connectors) when real credentials first need storing.
- **No job queue, scheduler, sync, LLM, delivery, billing, or quotas.** The
  queue table + worker loop is Feature 5; the rest later.
- **No ORM, no down-migrations, no seeded demo data.** The harness applies real
  migrations only; no fixtures beyond `schema_migrations` + `health`.
- **No observability stack beyond logs.** No Prometheus/Grafana/OTel; stdout
  logging with `LOG_LEVEL` is enough for the baseline. Metrics/tracing defer to a
  later ops feature.
- **No new workspaces or external stateful services.** No Redis, no 4th package,
  no `apps/*` return.
- **No frontend changes.** The mock Astro app is untouched; this feature is
  backend + infra + docs only.

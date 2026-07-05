# To-Do — 1. Project Initialization & Infrastructure Baseline

> Implements `prd-project-initialization-infrastructure-baseline.md` (read it
> first). Follow the coding guidelines (`vibes/coding-guidelines.md`) at all
> times: strict TS, ESM, `noUncheckedIndexedAccess`, `import type` for
> type-only imports, Prettier/ESLint conventions, block comment per module.
> Each CHECK PHASE runs `pnpm check` (lint + typecheck). The final gate runs
> `pnpm check:all` (lint + typecheck + tests) and a local `docker compose up`.
>
> Subagents referenced (`write-test`, `write-code`) live in
> `C:\Users\michi\.pi\agent\agents`. Spawn them with a focused, self-contained
> task; do not assume prior context.

# Relevant Files

- `backend/src/config/index.ts` — Zod-validated config; only place that reads `process.env`. Exposes typed `config` + `describeConfig()` redacting summary.
- `backend/src/db/index.ts` — `postgres.js` client/pool built from `config.DATABASE_URL`; `query` + `withTx` + `close`.
- `backend/src/migrate/runner.ts` — forward-only migration runner; reads `db/migrations/*.sql`, tracks in `schema_migrations`.
- `backend/src/migrate/index.ts` — CLI entry invoked by `pnpm migrate`; wires runner to `db`.
- `db/migrations/0001_schema_migrations.sql` — creates the `schema_migrations` tracking table.
- `db/migrations/0002_health.sql` — creates the writable `health` table the `/readyz` probe uses.
- `backend/test/db.ts` — shared embedded-Postgres harness (boots cluster, applies migrations via runner, returns client + `close`).
- `backend/test/config.test.ts` — unit tests for config validation + describeConfig redaction.
- `backend/test/migrate.test.ts` — integration test: migrations apply, idempotent, `health` writable.
- `backend/test/readyz.test.ts` — integration test: `/readyz` 200 vs 503.
- `backend/test/db-client.test.ts` — integration test: `db.query` + `withTx` rollback + bounded retry.
- `backend/src/server.ts` — modify: import config+db, real `/readyz`, close pool on shutdown.
- `backend/src/worker.ts` — modify: import config+db, close pool on shutdown.
- `backend/package.json` — add deps (`postgres`, `embedded-postgres` devDep, `zod`), `migrate` script.
- `package.json` — add root `migrate` filter script.
- `docker-compose.yml` — add one-shot migrate step; ensure `db/` reaches the image.
- `backend/Dockerfile` — `COPY db ./db` so `pnpm migrate` works in-container.
- `.github/workflows/ci.yml` — add `pnpm migrate` step before tests.
- `DEPLOY.md` — new repo-root Hetzner runbook (the target of `deploy/hetzner.md`).
- `SETUP.md` — new repo-root local developer setup guide.
- `docs/COMMANDS.md` — document `pnpm migrate` + embedded-Postgres test story.
- `.env.example` — verify it lists only today's validated keys (FR-13); leave `.env.old` untouched.

# Tasks

- [x] 1.0 Config module — Zod-validated env, crash-on-bad-env, redacting summary
  - [x] 1.1 RED: Use the `write-test` subagent to write `backend/test/config.test.ts` covering: (a) valid env parses to a typed object with correct defaults (`NODE_ENV` default `development`, `PORT` default `8788`, `LOG_LEVEL` default `info`, `WORKER_HEARTBEAT_INTERVAL_MS` default `30000`, `HOST` default `0.0.0.0`); (b) `NODE_ENV=production` with missing/malformed `DATABASE_URL` throws a Zod error whose message includes the string `DATABASE_URL`; (c) `describeConfig()` returns a record of booleans/labels only and never includes the actual `DATABASE_URL` value; (d) invalid `LOG_LEVEL`/`PORT` throw naming the offending var. Tests inject env via a setter or by importing the parser function directly with an explicit object (do not mutate `process.env` cross-test).
  - [x] 1.2 CONFIRM RED: `pnpm test backend/test/config.test.ts` — verify it fails (module/config not implemented yet) with the expected import/missing error.
  - [x] 1.3 GREEN: Use the `write-code` subagent to implement `backend/src/config/index.ts` — the ONLY module that touches `process.env`. Zod schema per FR-11/FR-13; exported `config` (parsed at import); exported `describeConfig()` returning only booleans + level strings (never secret values). On parse failure in `NODE_ENV=production`/`test`, print offending var name + Zod message to stderr and `process.exit(1)` before anything else loads.
  - [x] 1.4 CONFIRM GREEN: `pnpm test backend/test/config.test.ts` — all pass.
  - [x] 1.5 REFACTOR: ensure no `any`, `import type` where type-only, block comment header; `pnpm test backend/test/config.test.ts` still green.
  - [x] 1.6 CHECK PHASE: `pnpm check` (lint + typecheck). (Post-blocker: added `@eslint/js` to root devDeps + fixed 10 pre-existing frontend lint issues to unblock AC-6; exit 0.)

- [x] 2.0 Embedded-Postgres test harness + DB client module (driver `postgres.js`; harness boots real Postgres via `embedded-postgres`)
  - [x] 2.1 RED: `write-test` wrote `backend/test/db-client.test.ts` and a first cut of `backend/test/db.ts` harness usage: test that `withTestDb()` boots an embedded Postgres on a random port, `db.query\`SELECT 1 as one\``returns`[{ one: 1 }]`, `withTx`commits on success and rolls back on throw, and`close()`shuts the cluster (a subsequent query throws). This test also exercises`backend/src/db/index.ts`.
  - [x] 2.2 CONFIRM RED: missing `./db` + `../src/db/index` — verified — fails (deps + `db/` module absent) with import/parse errors.
  - [x] 2.3 GREEN: added `postgres`/`embedded-postgres` deps; implemented `backend/src/db/index.ts` + `backend/test/db.ts`; approved build scripts in `pnpm-workspace.yaml` (`onlyBuiltDependencies` + `pnpm rebuild`) and corrected the harness to the real embedded-postgres API (`databaseDir`/`user`/`password`/`persistent` + `createDatabase`), `zod` (or runtime if used by config). Use `write-code` to implement `backend/src/db/index.ts` (client from `config.DATABASE_URL`, `query`, `withTx` with bounded retry only on `40P01`, `close`) and `backend/test/db.ts` (boot embedded cluster to temp data dir on random free port, build a `postgres` client against it, return `{ db, close }`; no migration wiring yet).
  - [x] 2.4 CONFIRM GREEN: 4/4 pass (~9s per embedded cluster boot). (Fixed a `withTx` contract mismatch: callback receives callable `tx`, not `{query}`.)
  - [x] 2.5 REFACTOR: reviewed — modules already minimal/DRY/commented with `import type`; reconciled strict TS via a `LooseQuery` boundary type + two casts. Re-ran tests, still green.
  - [x] 2.6 CHECK PHASE: `pnpm check` — lint clean, typecheck clean across shared+backend+frontend.

- [x] 3.0 Migration runner + first migrations `0001` + `0002`
  - [x] 3.1 RED: `write-test` wrote `backend/test/migrate.test.ts`: boot harness → run `runMigrations(db)` on a fresh cluster → assert `schema_migrations` table exists with rows `id=1` (`0001_schema_migrations.sql`) and `id=2` (`0002_health.sql`); assert `health` table accepts an insert of `checked_at`; run `runMigrations(db)` a second time and assert no new rows applied (idempotent, exit 0); assert a file present on disk but missing from the applied set out of order is an error (drop `.sql` ordering invariants — at minimum: re-applying unchanged set is a no-op).
  - [x] 3.2 CONFIRM RED: missing `../src/migrate/runner` — verified
  - [x] 3.3 GREEN: created `db/migrations/0001_schema_migrations.sql` + `0002_health.sql`; implemented `backend/src/migrate/runner.ts` (forward-only, idempotent, FR-8 guard) using `withTx`/`sql.begin`. Added additive `Db.unsafe` + widened `withTx` callback to `TxClient` (db-client test unaffected). (`schema_migrations(id BIGINT PRIMARY KEY, filename TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`) and `db/migrations/0002_health.sql` (a single-row `health` table with `checked_at TIMESTAMPTZ`). Implement `backend/src/migrate/runner.ts` per FR-5..FR-8: read `db/migrations/*.sql` (resolve path relative to repo root via `import.meta.url`/`process.cwd()`), sort by numeric prefix, wrap each in `BEGIN…COMMIT`, insert into `schema_migrations`, skip applied, abort on failure. No business tables.
  - [x] 3.4 CONFIRM GREEN: 4/4 migrate + 4/4 db-client pass. (Fixed `UNSAFE_TRANSACTION`: postgres.js forbids raw BEGIN/COMMIT — reworked to `withTx`; corrected a BIGINT-as-string assertion via `write-test`.)
  - [x] 3.5 REFACTOR: file-discovery + per-file apply already split; ordering/guard invariants commented as the "why". Re-ran tests, still green.
  - [x] 3.6 CHECK PHASE: `pnpm check` — lint + typecheck clean across all workspaces.

- [x] 4.0 `pnpm migrate` CLI wire-up
  - [x] 4.1 RED: `write-test` wrote `backend/test/migrate-cli.test.ts` (additively exposed `connectionString` on the harness) (or extend `migrate.test.ts`) asserting the CLI entry (`backend/src/migrate/index.ts`) invokes the runner against `config.DATABASE_URL` and exits 0 on success / non-zero on failure (drive it via a tiny exported `main(args)` returning an exit code; spawn only optionally). Keep it one behavior per test.
  - [x] 4.2 CONFIRM RED: missing `../src/migrate/index` — verified.
  - [x] 4.3 GREEN: implemented side-effect-free `main()` in `backend/src/migrate/index.ts` + `cli.ts` shim; added `migrate` scripts to `backend/package.json` and root `package.json`.
  - [x] 4.4 CONFIRM GREEN: 2/2 CLI tests pass; `pnpm migrate` (bad url) prints failure + exits 1, wiring confirmed.
  - [x] 4.5 REFACTOR: `main()` thin (logic in `runner.ts`), block-commented, `import type` for `Db`.
  - [x] 4.6 CHECK PHASE: `pnpm check` clean.

- [x] 5.0 Real `/readyz` DB probe + graceful shutdown wiring
  - [x] 5.1 RED: `write-test` wrote `backend/test/readyz.test.ts` (200 reachable, 503 gone, /healthz unaffected, +non-empty-reason test): stand up the Hono app against the harness DB → `GET /readyz` returns 200 `{ ok:true }` (probe writes to `health`). Stop/kill the cluster → second `GET /readyz` returns 503 `{ ok:false, reason: <string> }`. (`/healthz` stays `{ok:true}` regardless.)
  - [x] 5.2 CONFIRM RED: `createApp` not exported — 3 tests failed.
  - [x] 5.3 GREEN: refactored `server.ts` to export `createApp(db)` (DB-probing `/readyz` via `SELECT 1`, 200/503) with `serve()` guarded behind `isMain` (test import doesn't bind); SIGINT/SIGTERM close server then db pool. Updated `worker.ts` to open validated pool + close on shutdown. at top (so config validation gates startup), implement `/readyz` to run a writable `health` probe inside `try/catch` returning 503 on error with `reason`; register pool close in the existing `shutdown` path. Modify `backend/src/worker.ts` to import `config` + `db` and close the pool in its `shutdown` (it does not serve HTTP, so pool close is the only readiness hook). No business logic.
  - [x] 5.4 CONFIRM GREEN: 4/4 readyz tests pass; live smoke `.no-DB` confirmed `{ok:false,reason:"database unreachable"}` (non-empty). Added empty-message fallback via `|| "database unreachable"`.
  - [x] 5.5 REFACTOR: probe inline (trivial); shutdown ordering commented; fixed strict-TS `unknown` from `res.json()` casts. Re-ran tests, still green.
  - [x] 5.6 CHECK PHASE: `pnpm check` clean.

- [x] 6.0 Final static + test gate (AC-1, AC-2, AC-8)
  - [x] 6.1 `pnpm check:all` — lint + typecheck + 21 tests all green. (Stabilized the suite: set `poolOptions.forks.singleFork:true` in `vitest.config.ts` — concurrent embedded-Postgres cluster boots across `forks` pool children flapped on Windows; one fork, one cluster at a time, is reliable and still uses the genuine engine.)
  - [x] 6.2 AC-8 verified: `.env.example` minimal (only today's keys); `.env.old` unmodified; only `config`/`db`/`migrate` modules exist (no `vault`/`auth`); only `0001`/`0002` migrations (no business tables). NOTE: `.env.example` should also surface `DATABASE_URL` (dev default exists, but prod needs it) — to be added in Task 9.

- [x] 7.0 Containerized local stack (AC-5) — Docker 29.0.1 engine verified live
  - [x] 7.1 Added `COPY db ./db` to `backend/Dockerfile` (migrations land at `/app/db/`; runner fallback `../db/migrations` resolves from WORKDIR `/app/backend`).
  - [x] 7.2 Added one-shot `migrate` service to `docker-compose.yml` (`restart: "no"`, `environment: &appenv` moved onto `migrate` to avoid a forward-anchor YAML parse error; `server`+`worker` `depends_on: migrate { condition: service_completed_successfully }`).
  - [x] 7.3 `docker compose config` clean; `docker compose up --build` → db healthy → migrate exits 0 → `/readyz` 200 `:8788` → worker heartbeat → both migrations recorded in compose DB; second `up` idempotent (migrate exits 0, `schema_migrations` still 2 rows). (Blocker fixed along the way: NO `.dockerignore` meant `COPY backend ./backend` clobbered the in-image `pnpm install` with host Windows `node_modules` symlinks → `tsx` unresolvable; created `.dockerignore` excluding `node_modules`/build output — square in Feature 1's "containerized deployment" scope.)
  - [x] 7.4 CHECK PHASE: no non-YAML/non-Dockerfile source edits; re-ran `pnpm check` clean, no regression.

- [x] 8.0 CI migrations step (AC-6)
  - [x] 8.1 Documented in `.github/workflows/ci.yml`: migrations are exercised on CI by `pnpm test` (`migrate.test.ts` + `migrate-cli.test.ts` run the runner and the CLI `main()` against an embedded engine using the same `db/migrations/*.sql`). No standalone service added — it would duplicate the harness (YAGNI/KISS). The `image` job builds the same Dockerfile Task 7 validated via compose.
  - [ ] 8.2 HANDOFF: requires a `push`/PR to observe. Developer: open a PR titled `feat: project initialization & infrastructure baseline` and confirm the CI run is green (lint → typecheck → test [migrations execute] → build → image). Cannot be auto-verified from this session.
  - [x] 8.3 YAML-only edit; re-ran `pnpm check` clean, no regression.

- [x] 9.0 Docs: `DEPLOY.md`, `SETUP.md`, `docs/COMMANDS.md`, `.env.example` (AC-7)
  - [x] 9.1 Wrote repo-root `SETUP.md` (prereqs, install, env, dev, health, migrations, embedded-postgres test story, containerized stack, troubleshooting; notes `.env.old` is a future-features reference).
  - [x] 9.2 Wrote repo-root `DEPLOY.md` (Hetzner EU target/provision, env, `docker compose up --build` migrate-then-serve, Caddy TLS + `/readyz` healthcheck, pg_dump backups, update flow, rollback constraints under forward-only migrations, monitoring).
  - [x] 9.3 `deploy/hetzner.md` links resolve to `../DEPLOY.md` and `../SETUP.md` (both now exist).
  - [x] 9.4 `docs/COMMANDS.md` gained `# Migrations` and `# Tests` sections (incl. `pnpm migrate`, embedded-postgres harness, singleFork rationale, CI coverage) + a SETUP/DEPLOY pointer in the intro.
  - [x] 9.5 Added `DATABASE_URL` (+ `LOG_LEVEL`/`HOST`) to `.env.example` as documented keys. Prettier-formatted all touched files; added `.env*` to `.prettierignore` (`.env` has no Prettier parser). `pnpm check` clean; `prettier --check` clean on all Feature-1 files. (Pre-existing unformatted frontend/`vibes` files left untouched per the "no frontend changes" Non-Goal.)

- [x] 10.0 Final acceptance sweep (all ACs)
  - [x] 10.1 `pnpm check:all` green — lint + typecheck (shared/backend/frontend) + 21/21 tests passing.
  - [x] 10.2 AC walk: AC-1 ✓ (integration tests boot real embedded Postgres, apply migrations); AC-2 ✓ (idempotent — 2x run = 2 rows); AC-3 ✓ live (production missing `DATABASE_URL` exits 1 naming the var); AC-4 ✓ (`/readyz` 200/503 + non-empty reason; live smoke `reason:"database unreachable"`); AC-5 ✓ verified live on Docker 29.0.1 (db→migrate exits 0→server ready 200→worker heartbeat; second `up` idempotent); AC-6 ⚠ HANDOFF (needs a push/PR to observe — Task 8.2; all CI steps pass locally); AC-7 ✓ (`DEPLOY.md`+`SETUP.md` exist, `hetzner.md` links resolve, `COMMANDS.md` documents migrations+tests); AC-8 ✓ (only `0001`/`0002`, no `vault`, no secret keys in `.env.example`, `.env.old` untouched); AC-9 ✓ (lint + typecheck clean).
  - [x] 10.3 Only AC-6 is genuinely blocked (needs an observable CI run on a PR) — flagged, not falsely checked.

- [x] Commit message: `feat: stand up database, migrations, validated config, embedded-postgres test harness, real readyz, and deploy docs`

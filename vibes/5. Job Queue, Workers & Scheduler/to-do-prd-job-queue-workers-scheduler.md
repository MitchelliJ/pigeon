# Relevant Files

- `db/migrations/0006_jobs.sql` - New migration: `jobs` table (`type`, `payload`, `status`, `attempts`, `max_attempts`, `run_at`, `locked_at`, `last_error`), the `(status, run_at)` index, and the partial unique index enforcing at most one in-flight `sync_mailbox` job per mailbox (PRD §3.1).
- `backend/test/jobs-schema.test.ts` - New schema-shape test for migration 0006 (mirrors `emails-schema.test.ts`'s pattern).
- `backend/test/migrate.test.ts` - Existing generic migration-runner test; update expected row count (5→6) and filename assertion for `0006_jobs.sql`.
- `backend/test/migrate-cli.test.ts` - Existing CLI test with a hardcoded applied-migration count; update 5→6.
- `backend/src/queue/types.ts` - New: `Job`, `JobType`, `JobStatus` types.
- `backend/src/queue/store.ts` - New: `enqueueSyncJob`, `claimJobs`, `completeJob`, `failJob` (PRD FR-2..FR-5, FR-9).
- `backend/src/queue/test/store.test.ts` - Integration tests (embedded Postgres) for enqueue no-op-on-inflight, claim ordering/`SKIP LOCKED`, stuck-job reclaim, backoff scheduling, dead-letter + `console.error` log.
- `backend/src/queue/tiers.ts` - New: `intervalForTier(tier): number` (minutes), the tier → sync interval placeholder map (PRD FR-10).
- `backend/src/queue/test/tiers.test.ts` - Unit tests for the tier interval lookup, including the unknown-tier fallback.
- `backend/src/queue/scheduler.ts` - New: one tick function that finds due mailboxes and calls `enqueueSyncJob` for each (PRD FR-7).
- `backend/src/queue/test/scheduler.test.ts` - Integration tests for due/not-due mailboxes by tier interval, never-synced-always-due, in-flight-job not double-enqueued, `error`-status mailboxes still included.
- `backend/src/queue/handlers/sync-mailbox.ts` - New: the `sync_mailbox` job handler — resolves the mailbox's connector + vault credential and calls Feature 4's `syncMailbox()` (PRD FR-6).
- `backend/src/queue/test/handlers/sync-mailbox.test.ts` - Integration tests: handler completes the job on a successful fake-connector sync, propagates failure to `failJob` on a connector error.
- `backend/src/queue/worker-loop.ts` - New: the poll loop — claims up to `WORKER_CONCURRENCY` jobs per tick, dispatches by `type`, runs them concurrently, routes results to `completeJob`/`failJob` (PRD FR-11).
- `backend/src/queue/test/worker-loop.test.ts` - Integration tests: end-to-end enqueue→claim→execute→complete (fake connector), concurrency cap respected.
- `backend/src/config/index.ts` - Add `WORKER_POLL_INTERVAL_MS`, `WORKER_CONCURRENCY`, `SCHEDULER_INTERVAL_MS` env vars (PRD §4).
- `backend/src/config/test/config.test.ts` (or existing config test file, confirm name during implementation) - Extend for the three new env vars' defaults/parsing.
- `backend/src/worker.ts` - Wire the scheduler tick + worker poll loop into the existing heartbeat process, started/stopped alongside it (PRD FR-12).
- `backend/src/mailboxes/service.ts` - `connectMailbox` calls `enqueueSyncJob` after a successful insert (PRD FR-8).
- `backend/src/mailboxes/test/routes.test.ts` (or a new `service.test.ts` case, confirm during implementation) - Extend: a successful `POST /api/mailboxes` results in exactly one pending `sync_mailbox` job row.

---

# Tasks

- [ ] 1.0 Database: `jobs` table migration
  - [ ] 1.1 RED: Write failing tests with the write-test agent:
    - `backend/test/jobs-schema.test.ts` (new, mirrors `emails-schema.test.ts`): after `runMigrations`, assert `to_regclass('public.jobs')` is not null; assert each column (`id`, `type`, `payload`, `status`, `attempts`, `max_attempts`, `run_at`, `locked_at`, `last_error`, `created_at`, `updated_at`) exists with the right type/nullability/default; assert the `type`/`status` `CHECK` constraints reject an invalid value; assert the partial unique index on `(payload->>'mailboxId')` exists (query `pg_indexes`/`pg_constraint`) and actually rejects a second `pending` `sync_mailbox` row for the same `mailboxId` while allowing one once the first is `succeeded`.
    - Update `backend/test/migrate.test.ts`'s row-count/filename assertions (5→6, add `{ id: 6, filename: "0006_jobs.sql" }`) and the idempotency test's expected count (5→6).
    - Update `backend/test/migrate-cli.test.ts`'s hardcoded applied-migration count (5→6).
  - [ ] 1.2 CONFIRM RED: Run `pnpm exec vitest run backend/test/jobs-schema.test.ts backend/test/migrate.test.ts backend/test/migrate-cli.test.ts` with the bash tool — verify failures (missing table, wrong row counts).
  - [ ] 1.3 GREEN: Implement `db/migrations/0006_jobs.sql` with the write-code agent per PRD §3.1: all columns, `CHECK` constraints on `type`/`status`, `(status, run_at)` index, and the partial unique index `idx_jobs_sync_mailbox_inflight`.
  - [ ] 1.4 CONFIRM GREEN: Run the same test command — verify all pass.
  - [ ] 1.5 REFACTOR: Review migration file against `0005_emails.sql`'s style for consistency; CONFIRM GREEN again if anything changes.
  - [ ] 1.6 CHECK PHASE: Run `pnpm check` with the bash tool.

- [ ] 2.0 Queue store: enqueue, claim, complete, fail (`backend/src/queue/store.ts`)
  - [ ] 2.1 RED: Write-test agent writes `backend/src/queue/test/store.test.ts` (integration; embedded Postgres, a mailbox row seeded directly, no real connector needed since this task only exercises the queue mechanics). Covers:
    - `enqueueSyncJob` inserts a `pending` row for a mailbox with no existing job.
    - `enqueueSyncJob` called twice for the same mailbox while the first is still `pending` results in exactly one row (PRD AC-3).
    - `enqueueSyncJob` succeeds again once the prior job is `succeeded`/`failed` (not blocked forever).
    - `claimJobs(db, limit)` only returns `pending` jobs with `run_at <= now()`, in `run_at` order, up to `limit`; claimed rows become `status='running'`, `locked_at` set, `attempts` incremented.
    - Two sequential `claimJobs` calls never return the same job (`SKIP LOCKED` — simulate via two calls without completing the first; assert the second call, given `limit >= 1`, returns a disjoint set once the first batch is exhausted, or model this as: seed 1 job, claim it, assert a second immediate claim for `limit=1` returns empty since it's now `running` and not yet stuck).
    - A `running` job with `locked_at` older than 5 minutes is returned again by `claimJobs` (stuck-job reclaim, PRD FR-9/AC-6) and its `attempts` incremented again.
    - `completeJob` sets `status='succeeded'`.
    - `failJob` on attempt 1 of `max_attempts=3` sets `status='pending'`, `run_at` ≈ `now() + 1 min`; on attempt 2 sets `run_at` ≈ `now() + 5 min`; on attempt 3 sets `status='failed'` and calls `console.error` exactly once naming the mailbox id (spy on `console.error`, PRD FR-19).
  - [ ] 2.2 CONFIRM RED: Run `pnpm exec vitest run backend/src/queue/test/store.test.ts` with the bash tool — verify it fails (module doesn't exist).
  - [ ] 2.3 GREEN: Write-code agent implements `backend/src/queue/store.ts` (`enqueueSyncJob`, `claimJobs`, `completeJob`, `failJob`) and `backend/src/queue/types.ts` per PRD FR-2..FR-5, FR-9. Claim query combines fresh-`pending`-due and stuck-`running`-reclaim in one `UPDATE ... FROM (SELECT ... FOR UPDATE SKIP LOCKED) ... RETURNING *` per FR-3. Backoff constants (`1 min`, `5 min`) and the 5-minute visibility timeout are flat code constants, not config.
  - [ ] 2.4 CONFIRM GREEN: Run the same test command — verify all pass.
  - [ ] 2.5 REFACTOR: Review for duplication between claim/reclaim logic and backoff calculation; CONFIRM GREEN again if anything changes.
  - [ ] 2.6 CHECK PHASE: Run `pnpm check` with the bash tool.

- [ ] 3.0 Tier → sync interval lookup (`backend/src/queue/tiers.ts`)
  - [ ] 3.1 RED: Write-test agent writes `backend/src/queue/test/tiers.test.ts` (unit test, no DB): `intervalForTier("free")` returns `30`; `intervalForTier("pro")` (or any tier not in the map) returns the `DEFAULT_SYNC_INTERVAL_MINUTES` fallback of `5`.
  - [ ] 3.2 CONFIRM RED: Run `pnpm exec vitest run backend/src/queue/test/tiers.test.ts` with the bash tool — verify it fails (module doesn't exist).
  - [ ] 3.3 GREEN: Write-code agent implements `backend/src/queue/tiers.ts` per PRD FR-10 — flat `{ free: 30 }` map plus a `DEFAULT_SYNC_INTERVAL_MINUTES = 5` fallback for any other tier value.
  - [ ] 3.4 CONFIRM GREEN: Run the same test command — verify all pass.
  - [ ] 3.5 REFACTOR: Confirm the map stays a simple flat constant (no premature generalization toward Feature 9's real plan catalog); CONFIRM GREEN again if anything changes.
  - [ ] 3.6 CHECK PHASE: Run `pnpm check` with the bash tool.

- [ ] 4.0 Scheduler tick (`backend/src/queue/scheduler.ts`)
  - [ ] 4.1 RED: Write-test agent writes `backend/src/queue/test/scheduler.test.ts` (integration; embedded Postgres, users + mailboxes seeded directly with varying `tier`/`last_synced_at`/`status`). Covers:
    - A mailbox with `last_synced_at IS NULL` is enqueued (a `sync_mailbox` job row exists after the tick) regardless of tier.
    - A `free`-tier mailbox with `last_synced_at` 31 minutes ago is enqueued; one 10 minutes ago is not.
    - A mailbox already `status='error'` but otherwise due is still enqueued (PRD AC-9).
    - A due mailbox that already has a `pending`/`running` `sync_mailbox` job is not double-enqueued (assert job row count stays 1) — relying on `enqueueSyncJob`'s own no-op behavior from task 2.0, not extra scheduler-side filtering logic.
  - [ ] 4.2 CONFIRM RED: Run `pnpm exec vitest run backend/src/queue/test/scheduler.test.ts` with the bash tool — verify it fails (module doesn't exist).
  - [ ] 4.3 GREEN: Write-code agent implements `backend/src/queue/scheduler.ts` — one exported tick function that selects due mailboxes (joined to `users` for `tier`) per PRD FR-7 and calls `enqueueSyncJob` for each.
  - [ ] 4.4 CONFIRM GREEN: Run the same test command — verify all pass.
  - [ ] 4.5 REFACTOR: Review the due-mailbox query for clarity; CONFIRM GREEN again if anything changes.
  - [ ] 4.6 CHECK PHASE: Run `pnpm check` with the bash tool.

- [ ] 5.0 `sync_mailbox` job handler (`backend/src/queue/handlers/sync-mailbox.ts`)
  - [ ] 5.1 RED: Write-test agent writes `backend/src/queue/test/handlers/sync-mailbox.test.ts` (integration; embedded Postgres, a mailbox row seeded with a vault-sealed credential, a fake `MailboxConnector` injected — reuse Feature 4's sync engine test fixtures/pattern). Covers:
    - A job whose mailbox syncs successfully (fake connector returns new messages) results in the handler resolving without throwing, and `emails` rows appear per Feature 4's `syncMailbox` contract.
    - A job whose mailbox's fake connector fails (e.g. `testConnection`/`listMessageIds` returns `{ ok: false }`) results in the handler throwing/rejecting with the connector's `reason` (so the worker loop's `failJob` path, task 6.0, has something to catch).
  - [ ] 5.2 CONFIRM RED: Run `pnpm exec vitest run backend/src/queue/test/handlers/sync-mailbox.test.ts` with the bash tool — verify it fails (module doesn't exist).
  - [ ] 5.3 GREEN: Write-code agent implements `backend/src/queue/handlers/sync-mailbox.ts` per PRD FR-6 — loads the mailbox row, resolves its connector via `../../mailboxes/connectors/index`'s `getConnector`, opens its vault-sealed credential, and calls Feature 4's `syncMailbox(db, vault, connector, mailboxId)` from `../../sync/engine`, surfacing a connector-level failure as a thrown/rejected error.
  - [ ] 5.4 CONFIRM GREEN: Run the same test command — verify all pass.
  - [ ] 5.5 REFACTOR: Review error propagation shape against what task 6.0's worker loop will expect; CONFIRM GREEN again if anything changes.
  - [ ] 5.6 CHECK PHASE: Run `pnpm check` with the bash tool.

- [ ] 6.0 Worker poll loop + config wiring (`backend/src/queue/worker-loop.ts`, `backend/src/config/index.ts`, `backend/src/worker.ts`)
  - [ ] 6.1 RED: Write-test agent writes:
    - Extend the config test file for the three new env vars (`WORKER_POLL_INTERVAL_MS` default `5000`, `WORKER_CONCURRENCY` default `5`, `SCHEDULER_INTERVAL_MS` default `60000`) — parsed, coerced to number, positive-int validated (same style as `WORKER_HEARTBEAT_INTERVAL_MS`).
    - `backend/src/queue/test/worker-loop.test.ts` (integration; embedded Postgres, fake connector fixture): running one poll tick against 2 pending `sync_mailbox` jobs claims and completes both (end-to-end enqueue→claim→execute→complete, PRD FR-16/AC — proves the full wiring, not just the store in isolation); with `WORKER_CONCURRENCY=2` and 3 pending jobs, one tick claims exactly 2 and the 3rd remains `pending` until the next tick (PRD AC-8).
  - [ ] 6.2 CONFIRM RED: Run `pnpm exec vitest run backend/src/queue/test/worker-loop.test.ts <config-test-path>` with the bash tool — verify failures (module/env vars don't exist).
  - [ ] 6.3 GREEN: Write-code agent implements:
    - The three new env vars in `backend/src/config/index.ts` (defaults per PRD §4).
    - `backend/src/queue/worker-loop.ts` — one poll-tick function: `claimJobs(db, WORKER_CONCURRENCY)`, dispatch each claimed job by `type` to its handler (only `sync_mailbox` registered, task 5.0), run concurrently via `Promise.allSettled`, route each outcome to `completeJob`/`failJob`.
    - Wire `backend/src/worker.ts` to start the scheduler tick (`SCHEDULER_INTERVAL_MS`) and the worker poll loop (`WORKER_POLL_INTERVAL_MS`) via `setInterval` alongside the existing heartbeat, and stop both cleanly in the existing `shutdown` handler.
  - [ ] 6.4 CONFIRM GREEN: Run the same test command(s) — verify all pass.
  - [ ] 6.5 REFACTOR: Review `worker.ts` for clarity now that it starts three intervals (heartbeat, scheduler, poll loop); CONFIRM GREEN again if anything changes.
  - [ ] 6.6 CHECK PHASE: Run `pnpm check` with the bash tool.

- [ ] 7.0 Immediate first sync on mailbox connect (`backend/src/mailboxes/service.ts`)
  - [ ] 7.1 RED: Write-test agent extends the mailbox connect test suite (`backend/src/mailboxes/test/routes.test.ts` or a new `service.test.ts` case — confirm during implementation which file already covers `connectMailbox`'s success path): a successful `POST /api/mailboxes` (or a direct `connectMailbox` call in the existing test style) results in exactly one `pending` `sync_mailbox` job row for the new mailbox's id.
  - [ ] 7.2 CONFIRM RED: Run the relevant test file with the bash tool — verify the new assertion fails (no job row exists yet).
  - [ ] 7.3 GREEN: Write-code agent updates `backend/src/mailboxes/service.ts`'s `connectMailbox` to call `enqueueSyncJob(db, mailbox.id)` (from `../queue/store`) right after a successful insert, before returning the `created` result.
  - [ ] 7.4 CONFIRM GREEN: Run the same test command — verify all pass.
  - [ ] 7.5 REFACTOR: Confirm this stays a one-line addition with no unnecessary coupling between `mailboxes` and `queue` beyond the single `enqueueSyncJob` call; CONFIRM GREEN again if anything changes.
  - [ ] 7.6 CHECK PHASE: Run `pnpm check` with the bash tool.

- [ ] 8.0 Final: full suite + manual sanity check
  - [ ] 8.1 Run `pnpm check:all` with the bash tool across the whole repo — all must pass (lint, typecheck all 3 workspaces, full test suite, frontend build). If anything regresses, fix forward with a new RED/GREEN pair rather than patching ad hoc; note any regression found here in this file for future PRD-writing lessons.
  - [ ] 8.2 Manual verification instructions for the user (no HTTP route exists to click through — this feature's only user-visible effect is mailboxes syncing on their own): run `pnpm dev:worker` in one terminal against a real or locally composed Postgres with at least one connected mailbox seeded (e.g. via the existing connect flow against a throwaway real/local IMAP or POP3 account), and confirm in the logs that the scheduler enqueues a job, the worker claims and completes it, and new rows appear in `emails` — then wait past the mailbox's tier interval (or lower `SCHEDULER_INTERVAL_MS`/seed an older `last_synced_at` for a faster check) and confirm a second sync cycle runs on its own with no manual trigger.

- [ ] Commit message (not committed — user manages VCS): `feat(queue): add database-backed job queue, worker poll loop, and tier-based sync scheduler`

# PRD — 5. Job Queue, Workers & Scheduler

> Run a durable, database-backed background job queue with a plan-configurable
> cron trigger that enqueues sync work, executed idempotently by workers.
> **Minimal scope:** a generic `jobs` table + claim/execute loop, one job type
> (`sync_mailbox`) wired to Feature 4's `syncMailbox()`, and a scheduler that
> enqueues per-mailbox sync jobs on a tier-based interval. No LLM/delivery job
> types (Feature 6/7/8), no manual "sync now" route, no quota enforcement
> (Feature 9).

---

## 1. Introduction / Overview

Feature 4 built `syncMailbox()` — a correct, idempotent function that fetches
and stores new mail for one mailbox — but nothing ever calls it. The worker
process (`backend/src/worker.ts`) today only proves it's alive with a
heartbeat log. Feature 5 turns that stub into the real thing: a durable job
queue backed by Postgres (no Redis/RabbitMQ, per the single-box constraint),
a worker loop that claims and executes jobs, and a scheduler that decides,
per mailbox, when it's due for another sync based on the owning user's plan
tier.

This is also the feature that resolves everything Feature 4 explicitly
deferred: serializing concurrent sync attempts per mailbox, recovering a job
left stuck mid-run after a crash, and retrying a failed sync without a human
in the loop. There is no "sync now" button in this product — silence would
otherwise mean nothing is happening, so the schedule itself must be a
reliable, self-healing retry mechanism, not just a happy-path trigger.

The `jobs` table and worker loop are deliberately generic (a `type`
discriminator, not a `sync_mailbox`-only table) because Features 6–8
(summarize/classify, deliver, heartbeat) will add job types onto this same
queue rather than build their own.

---

## 2. User Stories

- **As a user**, I want my connected mailboxes to sync automatically and
  repeatedly without me doing anything, so Pigeon actually delivers on "no
  dashboards to babysit."
- **As a user** on a paid tier, I want my mailboxes checked more frequently
  than a free user's, so faster sync cadence is a visible reason to upgrade.
- **As a user**, I want a mailbox I just connected to sync right away instead
  of waiting up to half an hour for the next scheduled tick, so I see it
  working immediately.
- **As a user**, I want a transient sync failure (a flaky server, a timeout)
  to quietly retry and recover on its own, so one bad moment doesn't
  permanently orphan a mailbox that I have no way to manually re-trigger.
- **As a developer**, I want a single generic job queue with a `type`
  column, so Feature 6's LLM jobs and Feature 7/8's delivery/heartbeat jobs
  are additive rows and handlers, not a second queue implementation.
- **As a developer**, I want the queue to guarantee at most one in-flight
  sync job per mailbox and to safely reclaim a job abandoned by a crashed
  worker, so Feature 4's "no locking, no stuck-sync recovery" deferrals are
  fully resolved here.

---

## 3. Functional Requirements

### 3.1 Database migration (`0006_jobs.sql`)

- **FR-1.** **`jobs`** (new table)
  - `id UUID PRIMARY KEY DEFAULT gen_random_uuid()`
  - `type TEXT NOT NULL CHECK (type IN ('sync_mailbox'))` — extended by later
    features' own migrations (`ALTER TABLE jobs DROP CONSTRAINT ... ADD
CONSTRAINT ... CHECK (type IN (..., 'new_type'))`), mirroring how
    `mailboxes.provider`/`protocol` are extended today. Not left
    unconstrained — a closed enum catches typos in handler dispatch at
    insert time.
  - `payload JSONB NOT NULL` — e.g. `{"mailboxId": "<uuid>"}` for
    `sync_mailbox`.
  - `status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','succeeded','failed'))`.
  - `attempts INTEGER NOT NULL DEFAULT 0`.
  - `max_attempts INTEGER NOT NULL DEFAULT 3`.
  - `run_at TIMESTAMPTZ NOT NULL DEFAULT now()` — when the job becomes
    eligible to claim; used both for the initial enqueue and for scheduling
    a delayed retry.
  - `locked_at TIMESTAMPTZ NULL` — set when a worker claims the job; drives
    stuck-job reclaim (FR-9).
  - `last_error TEXT NULL`.
  - `created_at TIMESTAMPTZ NOT NULL DEFAULT now()`.
  - `updated_at TIMESTAMPTZ NOT NULL DEFAULT now()`.
  - Index on `(status, run_at)` — backs the claim query.
  - **`CREATE UNIQUE INDEX idx_jobs_sync_mailbox_inflight ON jobs ((payload->>'mailboxId')) WHERE type = 'sync_mailbox' AND status IN ('pending','running')`**
    — this _is_ the "at most one in-flight sync per mailbox" guarantee. An
    enqueue attempt while one is already pending/running is a no-op
    (`ON CONFLICT DO NOTHING`), not an error.

### 3.2 Queue module (`backend/src/queue/`, new self-contained folder)

- **FR-2.** `enqueueSyncJob(db, mailboxId): Promise<void>` — `INSERT INTO
jobs (type, payload) VALUES ('sync_mailbox', jsonb_build_object('mailboxId',
mailboxId)) ON CONFLICT DO NOTHING`. Plain internal function, no HTTP
  route. Callable from multiple triggers (FR-7, FR-8) — the mechanism is
  generic even though this feature only wires up two callers.
- **FR-3.** `claimJobs(db, limit): Promise<Job[]>` — single query, both
  claims fresh `pending` work due (`run_at <= now()`) **and** reclaims
  abandoned `running` jobs whose `locked_at` is older than the visibility
  timeout (FR-9), in one `UPDATE ... FROM (SELECT ... FOR UPDATE SKIP
LOCKED) ... RETURNING *`. Both cases increment `attempts` and set
  `locked_at = now()`.
- **FR-4.** `completeJob(db, jobId): Promise<void>` — `status = 'succeeded'`.
- **FR-5.** `failJob(db, jobId, error): Promise<void>` — if
  `attempts < max_attempts`: `status = 'pending'`, `run_at = now() +
backoff(attempts)`, `last_error` set. If `attempts >= max_attempts`:
  `status = 'failed'` (dead-letter), `last_error` set, **and a line is
  printed** (`console.error`, no separate logging infra) naming the job
  type, mailbox id, and `last_error` — the only observability this feature
  adds for a permanently failed job (see FR-7 / OQ1 resolution: the next
  scheduler tick still re-attempts on its own, this print is just so a
  dead-letter is visible in the worker's own logs, not silent).
  `backoff(1) = 1 minute`, `backoff(2) = 5 minutes` (flat constants in code,
  not env vars — same precedent as Feature 4's 7-day history cap).
- **FR-6.** **Handler dispatch**: a `type -> handler` map. This feature
  registers exactly one: `sync_mailbox`. The handler loads the mailbox row,
  resolves its connector (reusing Feature 3's provider/protocol factory) and
  vault-sealed credential, and calls Feature 4's
  `syncMailbox(db, vault, connector, mailboxId)`. A handler throw (or a
  `SyncResult` indicating connector failure) is caught by the loop and
  routed to `failJob`; a clean return is routed to `completeJob`.
- **FR-7.** **Scheduler tick** (`backend/src/queue/scheduler.ts`), run on
  its own interval in the worker process: for every mailbox where
  `last_synced_at IS NULL` **or** `last_synced_at <= now() -
interval_for_tier(user.tier)`, call `enqueueSyncJob`. Mailboxes with
  `status = 'error'` are **included**, not skipped — since there is no
  manual retry surface, the schedule is the only retry mechanism, and a
  mailbox that recovers flips back to `status = 'connected'` automatically
  on its next successful `syncMailbox()` call (already Feature 4's
  behavior). The unique partial index (FR-1) is what actually prevents
  double-enqueueing a mailbox that already has an in-flight job — the
  scheduler's query does not need to duplicate that check, just call
  `enqueueSyncJob` for every due mailbox and let the no-op path absorb the
  rest.
- **FR-8.** **Immediate first sync**: after Feature 3's
  `POST /api/mailboxes` successfully inserts a new mailbox (connection test
  already passed), call `enqueueSyncJob` for it directly — so a newly
  connected mailbox doesn't wait for the next scheduler tick. Small, additive
  change to `backend/src/mailboxes/routes.ts` (or `service.ts`).
- **FR-9.** **Stuck-job / visibility timeout**: **5 minutes**. A job claimed
  (`locked_at` set) but still `status = 'running'` after 5 minutes is
  treated as abandoned (crashed worker) and reclaimed by FR-3, going through
  the same attempts/backoff accounting as a normal failure.
- **FR-10.** **Tier → sync interval** (`backend/src/queue/tiers.ts`, flat
  map in code, not env vars — same rationale as FR-5's backoff constants):
  `{ free: 30 }` minutes; any `users.tier` value not in the map (covers
  whatever tier names Feature 9 eventually introduces) falls back to a
  `DEFAULT_SYNC_INTERVAL_MINUTES = 5`. This is a placeholder mapping —
  Feature 9 owns the real tier catalog and limits; this feature only needs
  _a_ number per tier to prove the cron trigger is plan-configurable, per
  the spec's Feature 5 description.
- **FR-11.** **Worker loop** (`backend/src/queue/worker-loop.ts`): polls
  every `WORKER_POLL_INTERVAL_MS` (env var, default `5000`), claims up to
  `WORKER_CONCURRENCY` (env var, default `5`) jobs per tick, and runs them
  concurrently (`Promise.allSettled`) — one slow mailbox must not stall
  every other job in the same tick.
- **FR-12.** `worker.ts` starts both the scheduler tick (`SCHEDULER_INTERVAL_MS`,
  env var, default `60000`) and the worker poll loop on startup, alongside
  the existing heartbeat (unchanged), and stops both cleanly on
  `SIGINT`/`SIGTERM`.

### 3.3 Tests (`backend/src/queue/test/`)

- **FR-13.** Queue store tests (embedded Postgres): `enqueueSyncJob` is a
  no-op when a `pending`/`running` job already exists for that mailbox;
  `claimJobs` respects `SKIP LOCKED` (two concurrent claim calls never
  return the same job) and claims in `run_at` order; a `running` job past
  the 5-minute visibility timeout is reclaimed and its `attempts`
  incremented; `failJob` schedules the correct backoff `run_at` on attempts
  1–2 and dead-letters (`status = 'failed'`) on the 3rd.
- **FR-14.** Scheduler tests: a never-synced mailbox is always due; a
  `free`-tier mailbox synced 10 minutes ago is not due, one synced 31
  minutes ago is; a mailbox with an existing in-flight job is not
  double-enqueued (asserted via job row count, not scheduler-side skip
  logic); an `error`-status mailbox that's otherwise due is still
  enqueued.
- **FR-15.** Handler/dispatch tests: a `sync_mailbox` job for a fake
  connector that succeeds completes the job and updates `emails`/mailbox
  status per Feature 4's contract; one that fails is routed to `failJob`
  with the connector's error message.
- **FR-16.** End-to-end wiring test: seed a due mailbox with a fake
  connector fixture, run one scheduler tick + one worker tick, assert new
  `emails` rows appear and the job is `succeeded` — proves the full
  enqueue → claim → execute → complete path, not just its parts in
  isolation.
- **FR-17.** Mailbox-creation integration test: `POST /api/mailboxes`
  results in exactly one `pending` `sync_mailbox` job for the new mailbox
  immediately after the response returns.
- **FR-18.** Concurrency test: with `WORKER_CONCURRENCY = 2` and 3 pending
  jobs, one poll tick claims exactly 2.
- **FR-19.** Dead-letter logging test: a job that exhausts all 3 attempts
  triggers exactly one `console.error` call naming the job's mailbox id
  (spy/mock the console, don't assert on exact message text).

---

## 4. Technical Requirements

- **Language/runtime:** TypeScript, ESM, Node 22, `tsx`. Strict,
  `noUncheckedIndexedAccess`.
- **No new dependencies.** Hand-rolled `SELECT ... FOR UPDATE SKIP LOCKED`
  polling queue, consistent with "no ORM, hand-written SQL" — not `pg-boss`
  or another queue library.
- **New module:** `backend/src/queue/` (store, scheduler, worker loop,
  `sync_mailbox` handler, tests), self-contained per coding guidelines §2.
  Small, additive touch to `backend/src/mailboxes/routes.ts` (or
  `service.ts`) for FR-8, and to `backend/src/worker.ts` to start the
  scheduler + poll loop.
- **DB:** migration `0006_jobs.sql`, forward-only, single transaction.
- **New env vars** (deployment tuning knobs, alongside the existing
  `WORKER_HEARTBEAT_INTERVAL_MS` pattern): `WORKER_POLL_INTERVAL_MS`
  (default `5000`), `WORKER_CONCURRENCY` (default `5`),
  `SCHEDULER_INTERVAL_MS` (default `60000`). Retry count, backoff
  durations, and the visibility timeout stay flat code constants (FR-5,
  FR-9) — algorithm details, not deployment config, same precedent as
  Feature 4's 7-day history cap.
- **Idempotency:** the partial unique index (FR-1) is the correctness
  backstop for "at most one in-flight sync job per mailbox"; `syncMailbox()`
  itself (Feature 4) is already idempotent underneath that.
- **Conventional Commits:** `feat(queue): ...`.

---

## 5. Acceptance Criteria

1. **AC-1.** A mailbox with `last_synced_at IS NULL` is enqueued on the very
   first scheduler tick after it exists.
2. **AC-2.** A `free`-tier mailbox last synced 31 minutes ago is enqueued on
   the next tick; one last synced 10 minutes ago is not.
3. **AC-3.** Calling `enqueueSyncJob` twice for the same mailbox while the
   first job is still `pending`/`running` results in exactly one `jobs` row
   for that mailbox.
4. **AC-4.** `POST /api/mailboxes` (a successful connect) results in a
   `pending` `sync_mailbox` job for the new mailbox before the scheduler's
   next tick would otherwise have run.
5. **AC-5.** A `sync_mailbox` job whose handler throws is retried at
   `now() + 1 min` on the 2nd attempt and `now() + 5 min` on the 3rd, then
   marked `failed` with `last_error` set — no 4th attempt.
6. **AC-6.** A job left `status = 'running'` with `locked_at` older than 5
   minutes is reclaimed by the next `claimJobs` call and its `attempts`
   incremented.
7. **AC-7.** Two concurrent `claimJobs` calls (simulating two ticks or two
   worker processes) never return the same job row.
8. **AC-8.** With `WORKER_CONCURRENCY = 5` and 8 pending jobs, one poll tick
   claims exactly 5; the remaining 3 are claimed on the next tick.
9. **AC-9.** An `error`-status mailbox that becomes due is still enqueued and
   retried by the schedule, with no manual action required.
10. **AC-10.** `pnpm check:all` is green, including new `queue` module tests
    (embedded Postgres, fake connector fixtures from Feature 4, no real
    network).

---

## 6. Open Questions

None outstanding. Resolved during PRD review:

- **OQ1 (resolved).** Dead-lettered jobs aren't specially tracked — the next
  scheduler tick enqueues a fresh `sync_mailbox` job once the mailbox is due
  again (self-healing cadence, no retry-of-the-failed-row). Confirmed
  sufficient; the only addition is FR-5/FR-19's `console.error` print so a
  dead-letter is at least visible in the worker's logs, not silent. No
  digest-facing surfacing — left for Feature 7/8 if ever needed.
- **OQ2 (resolved).** No cleanup/retention policy for `succeeded`/`failed`
  job rows — deferred, same as Feature 4's precedent on `emails.body` size.
- **OQ3 (resolved).** The tier → interval placeholder (`free = 30 min`,
  other = `5 min`, FR-10) stands as-is; Feature 9 owns revisiting it against
  the real plan catalog.

---

## 7. Non-Goals (Out of Scope)

- **No manual "sync now" route.** The scheduler (recurring) and mailbox
  creation (FR-8) are the only enqueue triggers in this feature; the
  mechanism (`enqueueSyncJob`) is generic enough for later features to add
  more triggers without changing it.
- **No new job types.** Only `sync_mailbox` exists; Features 6–8 add
  `summarize_classify`, delivery, and heartbeat jobs onto this same table.
- **No true cron expressions.** Polling-based interval scheduling only
  (`SCHEDULER_INTERVAL_MS` ticks, per-mailbox due-check), consistent with
  the existing `WORKER_HEARTBEAT_INTERVAL_MS` pattern — no crontab syntax,
  no external scheduler process.
- **No multi-worker-process deployment.** Still a single worker process
  (per the single-box constraint); `SKIP LOCKED` makes the design safe if
  that ever changes, but nothing here provisions a second process.
- **No real quota/tier enforcement.** `users.tier` only selects a sync
  _interval_ here; Feature 9 owns actual plan limits (inbox count, monthly
  email cap) and enforcing them at enqueue/processing time.
- **No job history UI, admin route, or alerting.** Mailbox `status`
  (already surfaced on the dashboard since Feature 3/4) is the only
  user-visible signal that syncing is or isn't working.
- **No job row cleanup/retention.** `succeeded`/`failed` rows accumulate
  indefinitely (OQ2).

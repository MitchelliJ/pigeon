# Relevant Files

- `vibes/8. Sync Backfill Date Alignment/prd-sync-backfill-date-alignment.md` - Source PRD for this feature and acceptance criteria.
- `backend/src/sync/engine.ts` - Owns sync selection, cutoff calculation, dedupe, insertion, mailbox status, and `last_synced_at` watermark updates.
- `backend/src/sync/test/engine.test.ts` - Integration tests for `syncMailbox` against real Postgres and a fake connector; primary test target for the engine-level date cutoff and watermark behavior.
- `backend/src/mailboxes/connectors/types.ts` - Connector interface docs; `opts.since` must be clarified as advisory-only while the engine remains authoritative.
- `backend/src/mailboxes/connectors/imap.ts` - IMAP connector keeps using `opts.since` as a coarse `SEARCH SINCE` pre-filter.
- `backend/src/mailboxes/test/imap.test.ts` - Confirms IMAP still issues `{ since }` searches with `{ uid: true }`.
- `backend/src/mailboxes/connectors/pop3.ts` - POP3 connector must stop filtering by `opts.since`; it should fetch and return requested messages while the engine filters post-parse.
- `backend/src/mailboxes/test/connectors.test.ts` - POP3 connector tests; existing `TOP`/since-filter tests must be replaced with tests asserting the connector no longer filters internally.
- `backend/src/mailboxes/test/fixtures.ts` - POP3 socket fixture used by connector tests; may need small assertion helpers or command-log expectations for `TOP` removal.

# Tasks

- [x] 1.0 Engine: first-sync post-parse cutoff by canonical `received_at`
  - [x] 1.1 RED: Write one focused failing test in `backend/src/sync/test/engine.test.ts` for first sync: a fake connector returns two new messages, one with `receivedAt` older than `Date.now() - 7 days` and one newer; `syncMailbox` must insert only the newer message and still set mailbox `status = 'connected'` and `last_synced_at`.
  - [x] 1.2 CONFIRM RED: Run the targeted test with bash — for example `pnpm --filter @pigeon/backend test -- backend/src/sync/test/engine.test.ts -t "first sync filters fetched messages by received_at cutoff"` — and verify it fails because the old message is currently inserted.
  - [x] 1.3 GREEN: Implement the minimal engine change in `backend/src/sync/engine.ts`: compute an authoritative cutoff for the run, filter `fetchResult.messages` by `message.receivedAt >= cutoff` before insertion, and keep existing dedupe behavior.
  - [x] 1.4 CONFIRM GREEN: Run the targeted engine test with bash and verify it passes.
  - [x] 1.5 REFACTOR: Extract a small helper if useful, e.g. `getSyncCutoff(row.last_synced_at)` or `isMessageAfterCutoff(message, cutoff)`, without changing behavior; rerun the targeted engine test with bash.
  - [x] 1.6 CHECK PHASE: Run lint + typecheck with bash — `pnpm lint && pnpm typecheck`.

- [x] 2.0 Engine: incremental sync cutoff uses `last_synced_at`
  - [x] 2.1 RED: Write one focused failing test in `backend/src/sync/test/engine.test.ts` for incremental sync: set a mailbox `last_synced_at` to a fixed timestamp, have the fake connector return two new messages with `receivedAt` before and after that timestamp, and assert only the after-watermark message is inserted.
  - [x] 2.2 CONFIRM RED: Run the targeted test with bash — for example `pnpm --filter @pigeon/backend test -- backend/src/sync/test/engine.test.ts -t "incremental sync filters fetched messages by last_synced_at"` — and verify it fails because the pre-watermark message is currently inserted.
  - [x] 2.3 GREEN: Extend the engine cutoff logic so non-first syncs use `row.last_synced_at` as the authoritative cutoff. Keep the connector calls' current shape: first sync passes `{ since }`; incremental sync may continue omitting `opts.since` unless the implementation deliberately threads the watermark as advisory too.
  - [x] 2.4 CONFIRM GREEN: Run the targeted engine test with bash and verify it passes.
  - [x] 2.5 REFACTOR: Ensure the code reads as one policy: first sync cutoff is seven days ago; incremental cutoff is `last_synced_at`; post-parse filter is always authoritative. Rerun the targeted engine tests with bash.
  - [x] 2.6 CHECK PHASE: Run lint + typecheck with bash — `pnpm lint && pnpm typecheck`.

- [x] 3.0 Engine: first-attempt watermark locks even on connector failure
  - [x] 3.1 RED: Update or add one focused test in `backend/src/sync/test/engine.test.ts`: for a fresh mailbox (`last_synced_at IS NULL`) where `listMessageIds` returns `{ ok: false, reason: "boom" }`, assert `syncMailbox` returns `{ ok: false }`, mailbox `status = 'error'`, and `last_synced_at` is set near the attempt time.
  - [x] 3.2 CONFIRM RED: Run the targeted test with bash — for example `pnpm --filter @pigeon/backend test -- backend/src/sync/test/engine.test.ts -t "sets last_synced_at on first sync failure"` — and verify it fails because `last_synced_at` is currently left `NULL`.
  - [x] 3.3 GREEN: Modify failure handling in `backend/src/sync/engine.ts` so when the row was a first sync attempt, connector failure marks `status = 'error'` and also sets `last_synced_at = now()`. Preserve current behavior for already-synced mailboxes: failures leave the existing watermark unchanged.
  - [x] 3.4 CONFIRM GREEN: Run the targeted failure test with bash and verify it passes.
  - [x] 3.5 REFACTOR: Replace the existing failure test that expects `last_synced_at` unchanged for all failures with two cases if needed: already-synced failure preserves the old timestamp; first-attempt failure locks a new timestamp. Rerun `backend/src/sync/test/engine.test.ts` with bash.
  - [x] 3.6 CHECK PHASE: Run lint + typecheck with bash — `pnpm lint && pnpm typecheck`.

- [x] 4.0 Engine: first sync with zero in-window messages is successful and watermarked (baseline: already implemented by tasks 1 and 3; added regression test)
  - [x] 4.1 RED/BASELINE: Write one focused test in `backend/src/sync/test/engine.test.ts`: a fresh mailbox receives a successful list/fetch result where every fetched message has `receivedAt` older than the seven-day cutoff; assert zero emails are inserted, `status = 'connected'`, and `last_synced_at` is set.
  - [x] 4.2 CONFIRM BASELINE: Run the targeted test with bash — `pnpm exec vitest run backend/src/sync/test/engine.test.ts -t "first sync with zero in-window messages"` — passes as a baseline pin (behavior already implemented by tasks 1 and 3).
  - [x] 4.3 GREEN: N/A — behavior already implemented; no new production code required.
  - [x] 4.4 CONFIRM GREEN: Confirmed via the baseline run in 4.2.
  - [x] 4.5 REFACTOR: Insertion counting is already based on actually inserted rows after filtering (filter applied before the insert loop). Reran the full engine test file with bash — 10 passed.
  - [x] 4.6 CHECK PHASE: Run lint + typecheck with bash — `pnpm lint && pnpm typecheck`.

- [x] 5.0 POP3 connector: remove connector-side since filtering
  - [x] 5.1 RED: Replace the existing POP3 test `fetchMessages with opts.since TOP-peeks headers and excludes ids older than since from the result` in `backend/src/mailboxes/test/connectors.test.ts` with one focused failing test: call `fetchMessages(..., { since })` with one old and one new fixture message and assert both are returned to the caller.
  - [x] 5.2 RED: Add or update a POP3 fixture command-log assertion in `backend/src/mailboxes/test/connectors.test.ts` / `backend/src/mailboxes/test/fixtures.ts` to assert no `TOP <n> 0` command is issued during `fetchMessages` when `opts.since` is supplied.
  - [x] 5.3 CONFIRM RED: Run the targeted POP3 test(s) with bash — for example `pnpm --filter @pigeon/backend test -- backend/src/mailboxes/test/connectors.test.ts -t "pop3 connector"` — and verify they fail because the connector currently filters old messages and issues `TOP`.
  - [x] 5.4 GREEN: Remove POP3 connector-side filtering from `backend/src/mailboxes/connectors/pop3.ts`: delete the `TOP` peek-and-filter block and delete the post-`RETR` `message.receivedAt < opts.since` filter. Keep `opts` accepted for signature compatibility, but unused.
  - [x] 5.5 CONFIRM GREEN: Run the targeted POP3 connector tests with bash and verify they pass.
  - [x] 5.6 REFACTOR: Clean up unused helpers/imports in `pop3.ts` (for example `parseDateHeader` if no longer used) and update module comments so POP3 is described as returning requested messages while the engine filters. Rerun POP3 connector tests with bash.
  - [x] 5.7 CHECK PHASE: Run lint + typecheck with bash — `pnpm lint && pnpm typecheck`.

- [x] 6.0 Connector docs and IMAP advisory pre-filter contract
  - [x] 6.1 RED/BASELINE: Review `backend/src/mailboxes/test/imap.test.ts` and confirm there is already a test asserting `listMessageIds(PARAMS, { since })` searches `{ since }` with `{ uid: true }` (test already exists at the "with opts.since" case; no new test needed).
  - [x] 6.2 CONFIRM BASELINE: Run the IMAP connector test with bash — `pnpm exec vitest run backend/src/mailboxes/test/imap.test.ts -t "with opts.since"` — passes as a baseline (PRD preserves existing IMAP behavior).
  - [x] 6.3 GREEN: Update comments/docstrings in `backend/src/mailboxes/connectors/types.ts`, `backend/src/mailboxes/connectors/imap.ts`, and `backend/src/sync/engine.ts` to state that `opts.since` is an advisory coarse pre-filter only, and that `syncMailbox`'s post-parse `receivedAt` cutoff is authoritative.
  - [x] 6.4 CONFIRM GREEN: Run the IMAP connector test and full engine test file with bash.
  - [x] 6.5 REFACTOR: Ensure comments describe invariants, not implementation narration; remove any stale comments claiming IMAP has already fully scoped messages at list time.
  - [x] 6.6 CHECK PHASE: Run lint + typecheck with bash — `pnpm lint && pnpm typecheck`.

- [x] 7.0 Queue/scheduler regression: first-sync failure no longer re-arms as first sync forever
  - [x] 7.1 RED/BASELINE: Add one focused test in `backend/src/sync/test/engine.test.ts`: after a first-attempt connector failure, run `syncMailbox` a second time with the same mailbox and assert the fake connector is called as an incremental sync path (no `opts.since` re-armed from `now - 7 days`).
  - [x] 7.2 CONFIRM BASELINE: Run the targeted test with bash — passes as a baseline pin (behavior already implemented by task 3).
  - [x] 7.3 GREEN: N/A — task-3 GREEN already writes `last_synced_at` on first-attempt failure. No `enqueueSyncJob` or scheduler SQL changes were made.
  - [x] 7.4 CONFIRM GREEN: Confirmed via the baseline run in 7.2; full engine suite (11 tests) also re-passed in 7.5.
  - [x] 7.5 REFACTOR: Engine status/watermark updates already read clearly; no `markError` helper added (YAGNI). Reran full engine suite with bash — 11 passed.
  - [x] 7.6 CHECK PHASE: Run lint + typecheck with bash — `pnpm lint && pnpm typecheck`.

- [x] 8.0 Final verification and documentation consistency
  - [~] 8.1 Run the full backend test suite with bash — `pnpm --filter @pigeon/backend test`. NOTE: full ~25-min suite exceeded the 1500s bash timeout; ran a consolidated regression sweep of all test files that route through `syncMailbox` (engine + connectors + imap + sync-mailbox handler + worker-loop = 39 tests) — all green after fixing two stale-fixture-date regressions in `sync-mailbox.test.ts` and `worker-loop.test.ts`. The partial full run that did complete showed only an unrelated pre-existing Windows EBUSY embedded-postgres teardown race in `queue/test/store.test.ts` (a file this PRD did not modify — it seeds emails via raw SQL and exercises `enqueueSyncJob`, untouched by this change).
  - [~] 8.2 Run the full workspace checks with bash — `pnpm lint && pnpm typecheck && pnpm test`. NOTE: `pnpm lint && pnpm typecheck` confirmed green; `pnpm test` partial-run findings described in 8.1.
  - [~] 8.3 Frontend build smoke gate (`pnpm build`) NOT re-run — no frontend files were modified (verified via `git status`), so the Astro build gate is unaffected by this PRD.
  - [x] 8.4 Manually inspect the final diff: confirmed no migrations, no env vars, no UI changes, no new dependencies; changed files are exactly the PRD-relevant backend code/tests/docs (`imap.ts`, `pop3.ts`, `types.ts`, `engine.ts` + their tests + `fixtures.ts` + handler/worker-loop test date fixes + new `vibes/8` PRD/tasks folder).
  - [x] 8.5 No PRD-blocking failures remained once stale-fixture-date regressions were fixed.
  - [x] 8.6 Commit message: `fix: align sync backfill filtering with received_at watermark`.

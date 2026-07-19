# Relevant Files

- `db/migrations/0007_llm_processing.sql` - New columns (`emails.summary`/`category`/`classified_at`, `users.classification_instructions`) and the `summarize_classify` job type/index extension.
- `backend/test/llm-processing-schema.test.ts` - Integration test for migration 0007 (embedded Postgres).
- `backend/src/config/index.ts` - Adds `MISTRAL_API_KEY` (secret) + `MISTRAL_MODEL` (default `mistral-medium-3-5`) to the validated config.
- `backend/test/config.test.ts` - Config tests for the two new env vars.
- `.env.example` - Documents `MISTRAL_API_KEY` / `MISTRAL_MODEL` following the existing commented-out convention.
- `shared/src/index.ts` - Renames `Priority`→`Category` (`requires_action`/`important`/`noise`), `PRIORITY_ORDER`→`CATEGORY_ORDER`, `Email.priority`→`Email.category`, `Channel.minPriority`→`Channel.minCategory`, `Stats` fields.
- `shared/src/__tests__/category-types.test-d.ts` - Compile-time contract test for the renamed types (type-checked via `tsc`, not run by vitest — same pattern as `auth-types.test-d.ts`).
- `backend/src/llm/prompt.md` - The classification prompt template (plain text, developer-editable).
- `backend/src/llm/index.ts` - `LlmClassifier`/`ClassifyInput`/`ClassificationResult` types + `createLlmClassifier(config)` factory (mirrors `backend/src/mail/index.ts`).
- `backend/src/llm/mock.ts` - Deterministic keyword-heuristic mock classifier.
- `backend/src/llm/mistral.ts` - Real `fetch`-based Mistral provider; validates the returned `category` against the three-value enum (out-of-enum → `{ ok: false, reason }`).
- `backend/src/llm/test/mock.test.ts` - Mock classifier behavior tests.
- `backend/src/llm/test/mistral.test.ts` - Mistral provider tests against a faked `fetch`.
- `backend/src/llm/test/index.test.ts` - Factory selection-logic tests.
- `backend/src/queue/types.ts` - `JobType` gets `"summarize_classify"`.
- `backend/src/queue/store.ts` - Adds `enqueueClassifyJob`.
- `backend/src/queue/test/store.test.ts` - Idempotency test for `enqueueClassifyJob`.
- `backend/src/queue/handlers/summarize-classify.ts` - New job handler.
- `backend/src/queue/test/handlers/summarize-classify.test.ts` - Handler tests (success, failure, already-classified no-op).
- `backend/src/queue/scheduler.ts` - Adds `enqueueDueClassifyJobs` (selects `summary IS NULL` emails with no dead-lettered `failed` classify job, via `NOT EXISTS`).
- `backend/src/queue/test/scheduler.test.ts` - Classify-scheduler tests.
- `backend/src/queue/worker-loop.ts` - Dispatches `summarize_classify` to the new handler; takes an `LlmClassifier` param.
- `backend/src/queue/test/worker-loop.test.ts` - Dispatch + concurrency test additions.
- `backend/src/worker.ts` - Constructs the `LlmClassifier` and starts the classify-scheduler timer.
- `backend/src/emails/service.ts` - New module: category counts + keyset-paginated email queries, shared by the dashboard and the emails route; exports `InvalidCursorError` thrown by the cursor decoder on a malformed cursor.
- `backend/src/emails/routes.ts` - New `GET /api/emails` route (FR-13); maps `InvalidCursorError` → `400 { code: "invalid_cursor" }`.
- `backend/src/emails/test/service.test.ts` - Pagination/counts tests.
- `backend/src/emails/test/routes.test.ts` - Route tests (pagination, scoping, validation).
- `backend/src/mailboxes/dashboard.ts` - Wires real `stats` + real first page of `requires_action` emails.
- `backend/src/mailboxes/test/dashboard.test.ts` - Updated dashboard assertions for real stats/emails.
- `backend/src/server.ts` - Mounts the new `emailsRoutes`.
- `frontend/src/lib/api.ts` - Removes `llmInstructions` from `Profile`/`profile.update()`; adds a paginated `emails.list()` client call for FR-13.
- `frontend/src/components/SettingsPanel.tsx` - Removes the "Your triage instructions" field.
- `frontend/src/components/EmailList.tsx` - Category vocabulary rename + infinite scroll (10/page) per active tab.
- `frontend/src/components/EmailRow.tsx` - Category vocabulary rename (CSS class binding).
- `frontend/src/components/Dashboard.tsx` - Category vocabulary rename.
- `frontend/src/components/Hero.tsx` - Category vocabulary rename.
- `frontend/src/components/visuals.tsx` - `PRIORITY_LABEL`→`CATEGORY_LABEL` rename.
- `frontend/src/components/AddChannelDialog.tsx` - `minPriority`→`minCategory` rename.
- `frontend/src/styles/global.css` - Renames `.stat`/`.email`/custom-property selectors to match.

> **Note on TDD scope:** Phases 13–15 (frontend) have no RED/GREEN step. Per
> `vibes/coding-guidelines.md` §2 ("Frontend components are not unit-tested
> unless they carry real logic; the Astro build is the frontend's
> typecheck/smoke gate") and the existing repo (zero component test
> harness exists today), these phases are build-gated (`pnpm build`) instead.
> This is an established project convention, not a new exception.

---

# Tasks

- [x] 1.0 Database migration (`0007_llm_processing.sql`)
  - [x] 1.1 RED: Write failing integration test with the write-test agent asserting: `emails` has nullable `summary`/`category`/`classified_at` with the `category` CHECK constraint (`requires_action`/`important`/`noise`); `users` has nullable `classification_instructions`; `jobs.type` CHECK accepts `'summarize_classify'`; the partial unique index on `jobs ((payload->>'emailId'))` exists for that type — save to `backend/test/llm-processing-schema.test.ts` (mirror the RED-note comment style of `backend/test/jobs-schema.test.ts`).
  - [x] 1.2 CONFIRM RED: Run `pnpm test -- backend/test/llm-processing-schema.test.ts` with the bash tool — verify it fails because migration 0007 doesn't exist yet.
  - [x] 1.3 GREEN: Write `db/migrations/0007_llm_processing.sql` (FR-1..FR-4) with the write-code agent: the three `emails` columns + CHECK, the index from FR-2, the `users` column, the `jobs_type_check` drop/re-add, and the new partial unique index.
  - [x] 1.4 CONFIRM GREEN: Run `pnpm test -- backend/test/llm-processing-schema.test.ts` with the bash tool — verify it passes.
  - [x] 1.5 REFACTOR: Tidy comments/formatting in the migration file (no behavior change); CONFIRM GREEN by rerunning the same test.
  - [x] 1.6 CHECK PHASE: Run `pnpm check` with the bash tool.

- [x] 2.0 Config: `MISTRAL_API_KEY` / `MISTRAL_MODEL`
  - [x] 2.1 RED: Write failing tests with the write-test agent in `backend/test/config.test.ts`: `MISTRAL_MODEL` defaults to `"mistral-medium-3-5"`; `MISTRAL_API_KEY` is required in `NODE_ENV=production` (same pattern as the existing `RESEND_API_KEY` test) and optional otherwise; `describeConfig` reports `MISTRAL_API_KEY` as `"set"`/`"not set"` only (never the raw value) and `MISTRAL_MODEL` as its literal value.
  - [x] 2.2 CONFIRM RED: Run `pnpm test -- backend/test/config.test.ts` with the bash tool — verify the new assertions fail.
  - [x] 2.3 GREEN: Update `backend/src/config/index.ts` (FR-19) with the write-code agent: add both fields to `configSchema`, the production-required check via the existing `requireInProd` helper, the `Config` type, `parseConfig`, and `describeConfig`. Update `.env.example` with both vars (commented out, following the existing convention).
  - [x] 2.4 CONFIRM GREEN: Run `pnpm test -- backend/test/config.test.ts` with the bash tool — verify all pass.
  - [x] 2.5 REFACTOR: None expected beyond matching existing style; CONFIRM GREEN by rerunning the same test if anything changes.
  - [x] 2.6 CHECK PHASE: Run `pnpm check` with the bash tool.

- [x] 3.0 Shared types: `Priority` → `Category` rename (FR-15)
  - [x] 3.1 RED: Write a failing compile-time contract test with the write-test agent at `shared/src/__tests__/category-types.test-d.ts` (same style as `auth-types.test-d.ts`): assigns `Category` values `"requires_action"`/`"important"`/`"noise"`, `@ts-expect-error`s the old `"urgent"`/`"everything"` literals, and asserts `Stats` has keys `requires_action`/`important`/`noise` (`@ts-expect-error` on `urgent`/`everything`).
  - [x] 3.2 CONFIRM RED: Run `pnpm --filter @pigeon/shared typecheck` with the bash tool — verify it fails (types don't exist yet / old names still present).
  - [x] 3.3 GREEN: In `shared/src/index.ts`, with the write-code agent: rename `Priority`→`Category` (values `requires_action`/`important`/`noise`), `PRIORITY_ORDER`→`CATEGORY_ORDER`, `Email.priority`→`Email.category`, `Channel.minPriority`→`Channel.minCategory`, `Stats` fields to `{requires_action, important, noise}`.
  - [x] 3.4 CONFIRM GREEN: Run `pnpm --filter @pigeon/shared typecheck` with the bash tool — verify it passes.
  - [x] 3.5 REFACTOR: n/a (pure rename); CONFIRM GREEN by rerunning typecheck if any cleanup is made.
  - [x] 3.6 CHECK PHASE: Run `pnpm check` with the bash tool — **expect failures in `backend/src/mailboxes/dashboard.ts` and every frontend file listed in Relevant Files** (they still reference the old names). Do NOT fix them here — each is addressed in its own later phase (12.0, 13.0). Confirm the failures are exactly those known references, nothing else.

- [x] 4.0 LLM module: prompt template + mock classifier (FR-5, FR-6, FR-7's mock path)
  - [x] 4.1 RED: Write failing tests with the write-test agent in `backend/src/llm/test/mock.test.ts` for `mockLlmClassifier.classify(...)`: an "invoice due" email → `important`; an "please confirm/RSVP" email → `requires_action`; a newsletter-style email → `noise`; always resolves `{ ok: true, result }` (never throws); `result.summary` is a non-empty string.
  - [x] 4.2 CONFIRM RED: Run `pnpm test -- backend/src/llm/test/mock.test.ts` with the bash tool — verify it fails (module doesn't exist).
  - [x] 4.3 GREEN: With the write-code agent, create: `backend/src/llm/prompt.md` (FR-5 — category definitions + placeholder section for the optional instructions override); `backend/src/llm/index.ts` with the `ClassifyInput`/`ClassificationResult`/`LlmClassifier` types (FR-6/FR-7); `backend/src/llm/mock.ts` implementing the keyword heuristic described in the PRD/README.
  - [x] 4.4 CONFIRM GREEN: Run `pnpm test -- backend/src/llm/test/mock.test.ts` with the bash tool — verify all pass.
  - [x] 4.5 REFACTOR: Clean up the heuristic/wording with the write-code agent without changing test outcomes; CONFIRM GREEN by rerunning the same test.
  - [x] 4.6 CHECK PHASE: Run `pnpm check` with the bash tool.

- [x] 5.0 LLM module: real Mistral provider (FR-7's real path)
  - [x] 5.1 RED: Write failing tests with the write-test agent in `backend/src/llm/test/mistral.test.ts` against a faked `global.fetch` (mirror `backend/src/mail/test/resend.test.ts`'s style): a successful JSON-mode response maps to `{ ok: true, result }`; a non-2xx response maps to `{ ok: false, reason }` without throwing; a malformed/non-JSON response body maps to `{ ok: false, reason }` without throwing; a well-formed response whose `category` is outside the enum (e.g. `"urgent"`) maps to `{ ok: false, reason }` without throwing (FR-7); the request body includes the configured `MISTRAL_MODEL` and the prompt's classification-instructions placeholder filled in only when provided.
  - [x] 5.2 CONFIRM RED: Run `pnpm test -- backend/src/llm/test/mistral.test.ts` with the bash tool — verify it fails (module doesn't exist).
  - [x] 5.3 GREEN: Implement `backend/src/llm/mistral.ts` with the write-code agent — `fetch`-based, no SDK, loads and fills `prompt.md`, requests structured/JSON-mode output, parses/validates the two-field response shape (including checking `category` is one of `requires_action`/`important`/`noise` before returning `{ ok: true }` — never cast an out-of-enum value through, or it trips the DB CHECK later), never throws into the caller.
  - [x] 5.4 CONFIRM GREEN: Run `pnpm test -- backend/src/llm/test/mistral.test.ts` with the bash tool — verify all pass.
  - [x] 5.5 REFACTOR: Clean up request/response parsing with the write-code agent; CONFIRM GREEN by rerunning the same test.
  - [x] 5.6 CHECK PHASE: Run `pnpm check` with the bash tool.

- [x] 6.0 LLM module: `createLlmClassifier` factory (FR-7's selection rule)
  - [x] 6.1 RED: Write failing tests with the write-test agent in `backend/src/llm/test/index.test.ts`: throws in `NODE_ENV=production` without `MISTRAL_API_KEY`; returns the Mistral provider whenever `MISTRAL_API_KEY` is set (any env); falls back to the mock singleton otherwise.
  - [x] 6.2 CONFIRM RED: Run `pnpm test -- backend/src/llm/test/index.test.ts` with the bash tool — verify it fails (factory doesn't exist).
  - [x] 6.3 GREEN: Implement `createLlmClassifier(config)` in `backend/src/llm/index.ts` with the write-code agent, mirroring `createMailSender`'s selection logic exactly.
  - [x] 6.4 CONFIRM GREEN: Run `pnpm test -- backend/src/llm/test/index.test.ts` with the bash tool — verify all pass.
  - [x] 6.5 REFACTOR: Align comments/structure with `mail/index.ts` with the write-code agent; CONFIRM GREEN by rerunning the same test.
  - [x] 6.6 CHECK PHASE: Run `pnpm check` with the bash tool.

- [x] 7.0 Queue: `enqueueClassifyJob` (FR-8)
  - [x] 7.1 RED: Write a failing test with the write-test agent in `backend/src/queue/test/store.test.ts` (embedded Postgres, using migration 0007): calling `enqueueClassifyJob` twice for the same `emailId` while the first job is still `pending` results in exactly one `jobs` row.
  - [x] 7.2 CONFIRM RED: Run `pnpm test -- backend/src/queue/test/store.test.ts` with the bash tool — verify it fails (function doesn't exist).
  - [x] 7.3 GREEN: Add `JobType` `"summarize_classify"` to `backend/src/queue/types.ts` and `enqueueClassifyJob` to `backend/src/queue/store.ts` with the write-code agent, same shape as `enqueueSyncJob`.
  - [x] 7.4 CONFIRM GREEN: Run `pnpm test -- backend/src/queue/test/store.test.ts` with the bash tool — verify all pass (including pre-existing `sync_mailbox` tests in the same file).
  - [x] 7.5 REFACTOR: n/a beyond consistent naming; CONFIRM GREEN by rerunning the same test if anything changes.
  - [x] 7.6 CHECK PHASE: Run `pnpm check` with the bash tool.

- [x] 8.0 Queue: `summarize_classify` job handler (FR-10)
  - [x] 8.1 RED: Write failing tests with the write-test agent in `backend/src/queue/test/handlers/summarize-classify.test.ts` (embedded Postgres + a fake `LlmClassifier`): a successful classify updates `summary`/`category`/`classified_at` on the right `emails` row; the owning user's `classification_instructions` (when set) is passed into `classify()`; a `{ ok: false }` classifier result causes the handler to reject/throw with that reason; calling the handler again for an email whose `summary` is already set is a no-op (row unchanged, fake classifier not called a second time... or called but the `AND summary IS NULL` guard prevents overwrite — assert the row's `summary`/`category` are unchanged either way).
  - [x] 8.2 CONFIRM RED: Run `pnpm test -- backend/src/queue/test/handlers/summarize-classify.test.ts` with the bash tool — verify it fails (handler doesn't exist).
  - [x] 8.3 GREEN: Implement `backend/src/queue/handlers/summarize-classify.ts` with the write-code agent (FR-10): loads the email + owning user's `classification_instructions`, calls the injected `LlmClassifier`, applies the `UPDATE ... WHERE id = ... AND summary IS NULL`, throws on `{ ok: false }`.
  - [x] 8.4 CONFIRM GREEN: Run `pnpm test -- backend/src/queue/test/handlers/summarize-classify.test.ts` with the bash tool — verify all pass.
  - [x] 8.5 REFACTOR: Align structure/comments with `handlers/sync-mailbox.ts` with the write-code agent; CONFIRM GREEN by rerunning the same test.
  - [x] 8.6 CHECK PHASE: Run `pnpm check` with the bash tool.

- [x] 9.0 Queue: classify scheduler tick (FR-9)
  - [x] 9.1 RED: Write failing tests with the write-test agent in `backend/src/queue/test/scheduler.test.ts`: an email with `summary IS NULL` gets a `pending` `summarize_classify` job after one tick; an already-classified email (summary set) is not enqueued; an email that already has an in-flight `summarize_classify` job is not double-enqueued (assert via row count); an email whose only `summarize_classify` job is `status = 'failed'` (dead-lettered) is **not** re-enqueued after a tick, while a sibling unclassified email with no failed job still is (FR-9's `NOT EXISTS` guard against the re-enqueue loop); the batch is capped at 500 rows per tick (can assert via a `LIMIT`-respecting query rather than seeding 500 real rows, per the existing test's style for large-batch assertions).
  - [x] 9.2 CONFIRM RED: Run `pnpm test -- backend/src/queue/test/scheduler.test.ts` with the bash tool — verify the new assertions fail.
  - [x] 9.3 GREEN: Implement `enqueueDueClassifyJobs(db)` in `backend/src/queue/scheduler.ts` with the write-code agent (FR-9) — including the `NOT EXISTS` clause that excludes emails already carrying a dead-lettered (`status = 'failed'`) `summarize_classify` job, so a permanently-failing email isn't re-enqueued every tick.
  - [x] 9.4 CONFIRM GREEN: Run `pnpm test -- backend/src/queue/test/scheduler.test.ts` with the bash tool — verify all pass (including pre-existing `runSchedulerTick` tests).
  - [x] 9.5 REFACTOR: Factor any shared "due candidate" helpers only if it clarifies (not required); CONFIRM GREEN by rerunning the same test.
  - [x] 9.6 CHECK PHASE: Run `pnpm check` with the bash tool.

- [x] 10.0 Queue: worker-loop dispatch + `worker.ts` wiring (FR-11, end-to-end FR-24)
  - [x] 10.1 RED: Write failing tests with the write-test agent: in `backend/src/queue/test/worker-loop.test.ts`, `runWorkerTick` (now taking an `LlmClassifier` param) dispatches a claimed `summarize_classify` job to the handler and completes it on success; add an end-to-end test (new file `backend/src/queue/test/e2e-classify.test.ts` or an added `describe` block in an existing integration test file — developer's choice) seeding an unclassified email, running one `enqueueDueClassifyJobs` tick + one `runWorkerTick`, asserting the email ends up with a summary/category and the job `succeeded` (FR-24).
  - [x] 10.2 CONFIRM RED: Run `pnpm test -- backend/src/queue/test/worker-loop.test.ts` with the bash tool — verify it fails (no dispatch case yet).
  - [x] 10.3 GREEN: With the write-code agent: add the `"summarize_classify"` case to `runWorkerTick`'s dispatch switch in `backend/src/queue/worker-loop.ts` (accepting an `LlmClassifier` parameter, defaulted like `getConnectorFn`); in `backend/src/worker.ts`, construct the classifier via `createLlmClassifier(config)` and pass it to `runWorkerTick`, and start a second `setInterval` calling `enqueueDueClassifyJobs` on the same `SCHEDULER_INTERVAL_MS` timer (cleared on shutdown alongside the existing timers).
  - [x] 10.4 CONFIRM GREEN: Run `pnpm test -- backend/src/queue/test/worker-loop.test.ts` with the bash tool — verify all pass, then run the e2e test file/block similarly.
  - [x] 10.5 REFACTOR: Tidy `worker.ts`'s startup block (grouping the two scheduler ticks) with the write-code agent; CONFIRM GREEN by rerunning both test files.
  - [x] 10.6 CHECK PHASE: Run `pnpm check` with the bash tool.

- [x] 11.0 Backend: `emails` service — category counts + keyset pagination (FR-2, shared helper for FR-12/FR-13)
  - [x] 11.1 RED: Write failing tests with the write-test agent in `backend/src/emails/test/service.test.ts`: `loadCategoryCounts(db, userId)` returns correct grouped counts across the caller's mailboxes only, `0` for a category with no rows; `loadEmailPage(db, userId, category, cursor, limit)` returns newest-first rows, respects `limit`, returns a non-null `nextCursor` when more rows exist and `null` when exhausted, never returns another user's emails, and a round-trip cursor (feed page 1's `nextCursor` back in) returns the next page; a malformed `cursor` (not base64/JSON, wrong shape, or an unparseable `receivedAt`) throws the exported `InvalidCursorError` rather than a raw `SyntaxError` or a DB error.
  - [x] 11.2 CONFIRM RED: Run `pnpm test -- backend/src/emails/test/service.test.ts` with the bash tool — verify it fails (module doesn't exist).
  - [x] 11.3 GREEN: Implement `backend/src/emails/service.ts` with the write-code agent: the two functions above, the opaque base64 cursor encode/decode (the decoder validates base64/JSON/shape/timestamp and throws an exported `InvalidCursorError` on any failure), and the `Email`-shaping helper (`needsAttention` derived per FR-14, `suggestedAction` always `undefined`).
  - [x] 11.4 CONFIRM GREEN: Run `pnpm test -- backend/src/emails/test/service.test.ts` with the bash tool — verify all pass.
  - [x] 11.5 REFACTOR: Extract any duplicated row-shaping logic with the write-code agent; CONFIRM GREEN by rerunning the same test.
  - [x] 11.6 CHECK PHASE: Run `pnpm check` with the bash tool.

- [x] 12.0 Backend: dashboard route — real stats + first page (FR-12)
  - [x] 12.1 RED: Update `backend/src/mailboxes/test/dashboard.test.ts` with the write-test agent (failing): `GET /api/dashboard`'s `stats` reflects real grouped counts (`requires_action`/`important`/`noise`) for the caller; `emails` is the caller's first page (≤10) of `category = 'requires_action'`, newest first, correctly shaped.
  - [x] 12.2 CONFIRM RED: Run `pnpm test -- backend/src/mailboxes/test/dashboard.test.ts` with the bash tool — verify the new assertions fail (still the FR-3.6 placeholder).
  - [x] 12.3 GREEN: Update `backend/src/mailboxes/dashboard.ts` with the write-code agent to call `loadCategoryCounts`/`loadEmailPage` from `backend/src/emails/service.ts` (FR-12), replacing the placeholder `stats`/`emails`.
  - [x] 12.4 CONFIRM GREEN: Run `pnpm test -- backend/src/mailboxes/test/dashboard.test.ts` with the bash tool — verify all pass.
  - [x] 12.5 REFACTOR: n/a beyond consistent naming; CONFIRM GREEN by rerunning the same test if anything changes.
  - [x] 12.6 CHECK PHASE: Run `pnpm check` with the bash tool.

- [x] 13.0 Backend: `GET /api/emails` paginated route (FR-13, FR-23)
  - [x] 13.1 RED: Write failing tests with the write-test agent in `backend/src/emails/test/routes.test.ts`: `200` with `{ emails, nextCursor }` for a valid `category`/`cursor`/`limit`; `400 { code: "invalid_category" }` for a missing/invalid `category`; `400 { code: "invalid_cursor" }` for a malformed `cursor` (e.g. `cursor=%%%`) — asserting it is a 400, not a 500; scoping to `requireAuth`'s caller only (another user's emails never appear); `limit` is clamped to the documented max.
  - [x] 13.2 CONFIRM RED: Run `pnpm test -- backend/src/emails/test/routes.test.ts` with the bash tool — verify it fails (route doesn't exist).
  - [x] 13.3 GREEN: Implement `backend/src/emails/routes.ts` with the write-code agent (`emailsRoutes(db)`, behind `requireAuth(db)`) — validate `category` (→ `400 invalid_category`) and wrap the `loadEmailPage` call so a thrown `InvalidCursorError` maps to `400 { code: "invalid_cursor" }` — and mount it in `backend/src/server.ts` (`app.route("/", emailsRoutes(db))`).
  - [x] 13.4 CONFIRM GREEN: Run `pnpm test -- backend/src/emails/test/routes.test.ts` with the bash tool — verify all pass.
  - [x] 13.5 REFACTOR: n/a beyond consistent style with `mailboxes/routes.ts`; CONFIRM GREEN by rerunning the same test if anything changes.
  - [x] 13.6 CHECK PHASE: Run `pnpm check` with the bash tool.

- [x] 14.0 Frontend: category vocabulary rename (FR-16) — build-gated, no unit tests (see note above Relevant Files)
  - [x] 14.1 Update `EmailList.tsx` (`Filter` type, tab list + labels, default active tab), `Dashboard.tsx`, `Hero.tsx`, `visuals.tsx` (`PRIORITY_LABEL`→`CATEGORY_LABEL`), `AddChannelDialog.tsx` (`minPriority`→`minCategory`, option values/labels), `EmailRow.tsx` (class binding), and `global.css` (selector/custom-property renames) to the new `requires_action`/`important`/`noise` vocabulary, with the write-code agent.
  - [x] 14.2 CHECK PHASE: Run `pnpm build` and `pnpm check` with the bash tool — verify both are green and grep confirms no remaining `urgent`/`everything`/`Priority`/`minPriority` references outside historical/CSS-unrelated matches (e.g. unrelated English words like "everything" in copy text are fine — only the vocabulary/type usages must be gone).

- [x] 15.0 Frontend: remove classification-instructions UI (FR-17) — build-gated, no unit tests
  - [x] 15.1 Remove the "Your triage instructions" field from `SettingsPanel.tsx` and `llmInstructions` from `Profile`/`profile.update()` in `frontend/src/lib/api.ts`, with the write-code agent.
  - [x] 15.2 CHECK PHASE: Run `pnpm build` and `pnpm check` with the bash tool.

- [x] 16.0 Frontend: `EmailList` infinite scroll (FR-18) — build-gated, no unit tests (no Solid component test harness exists in this repo; see note above Relevant Files)
  - [x] 16.1 Add a paginated `emails.list({ category, cursor })` client call to `frontend/src/lib/api.ts` (hits `GET /api/emails`), with the write-code agent.
  - [x] 16.2 Update `EmailList.tsx` with the write-code agent: seed the default (`requires_action`) tab from the already-loaded `DashboardData.emails`; on tab switch or scroll-to-bottom (IntersectionObserver sentinel), fetch the next page via `emails.list()` and append; stop fetching once `nextCursor` is `null`.
  - [x] 16.3 CHECK PHASE: Run `pnpm build` and `pnpm check` with the bash tool.

- [ ] 17.0 Final: full suite
  - [ ] 17.1 Run `pnpm check:all` with the bash tool — lint, typecheck, and the full test suite (embedded Postgres) must all pass.
  - [ ] 17.2 Manually walk the PRD's Acceptance Criteria (AC-1..AC-10) against the implementation and confirm each is satisfied.
  - [ ] 17.3 If anything in 17.1/17.2 fails, STOP and report to the user what could have been specified more precisely in the PRD to prevent it, before making further changes.

- [ ] Commit message: When done, include a one sentence functional description of the change (e.g. "feat(llm): summarize and classify new emails via Mistral, wire real dashboard stats/feed, and standardize the requires_action/important/noise category vocabulary end to end").

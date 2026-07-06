# PRD — 6. LLM Processing (Summarize + Classify)

> For each new email, make a single Mistral call returning a one-sentence
> summary and one of three categories (`requires_action` / `important` /
> `noise`), honoring an optional per-user plain-language classification
> instruction. Runs as a new `summarize_classify` job type on Feature 5's
> generic queue. Also standardizes the category vocabulary end-to-end
> (backend, shared types, frontend) — the placeholder mock-era naming
> (`Priority`: `urgent`/`important`/`everything`) is replaced by the spec's
> real triage vocabulary.

---

## 1. Introduction / Overview

Feature 4 fetches and stores new mail. Feature 5 turns that into a durable,
scheduled background job. Nothing yet reads an email's content and decides
what it's about or whether it matters — every stored email just sits there
with a `NULL` summary, and the dashboard's `emails`/`stats` fields are still
inert placeholders (`dashboard.ts` explicitly marks both as "Feature 6" work).

This feature adds the actual triage: a `summarize_classify` job (additive to
Feature 5's `jobs` table, exactly as that PRD anticipated) that, for every
email lacking a summary, makes one Mistral call and stores back a
one-sentence summary plus a category. A lightweight scheduler tick — the
same polling pattern as Feature 5's sync scheduler — finds unclassified
emails and enqueues jobs for them, so this feature touches zero lines of
Feature 4/5 code. The dashboard route is then wired to real data: real
per-category counts and a real, paginated email feed.

Along the way, this feature also fixes a naming mismatch left over from the
original mock-data build: the frontend's `Priority` type
(`urgent`/`important`/`everything`) never matched the spec's actual three
buckets (`requires action` / `important` / `status-noise`). This PRD
renames that type to `Category` with values `requires_action` / `important`
/ `noise`, end to end — shared types, backend, and every frontend usage —
so there is exactly one vocabulary for "what bucket is this email in,"
matching the DB column this feature adds.

---

## 2. User Stories

- **As a user**, I want every new email to arrive already summarized and
  bucketed, so I never have to open my inbox to know what's in it.
- **As a user**, I want emails that need my attention clearly distinguished
  from ones that don't, so I trust the digest to actually rank things
  correctly.
- **As a user**, I want the dashboard's stat cards and email feed to show
  real numbers and real triaged emails, not placeholders.
- **As a user**, I want to keep scrolling through my triaged emails (not
  just the newest handful), so nothing feels hidden from me even though the
  initial view stays compact.
- **As a developer**, I want the summarize/classify prompt to live in its
  own plain-text file, so I can tune it without spelunking through TypeScript.
- **As a developer**, I want `summarize_classify` to be just another row
  type on Feature 5's queue, so retries, backoff, and dead-lettering are
  free — no separate retry logic to write.
- **As a developer**, I want exactly one category vocabulary shared by the
  DB, the backend, and the frontend, so a value never needs translating at
  a layer boundary.

---

## 3. Functional Requirements

### 3.1 Database migration (`0007_llm_processing.sql`)

- **FR-1.** `emails` gets three new nullable columns: `summary TEXT NULL`,
  `category TEXT NULL CHECK (category IN ('requires_action','important','noise'))`,
  `classified_at TIMESTAMPTZ NULL`. `NULL` summary/category means "not yet
  processed" — this _is_ the queue's work-selection predicate (FR-6), not a
  separate status column.
- **FR-2.** `CREATE INDEX idx_emails_category_received_at ON emails(category, received_at DESC);`
  — backs both the dashboard's per-category counts and the paginated feed
  query (FR-9/FR-10).
- **FR-3.** `users` gets one new nullable column:
  `classification_instructions TEXT NULL` — an optional plain-language
  override consulted by the prompt (FR-5) when set. No route reads or
  writes this column in this feature (see Non-Goals) — it exists so the
  architecture is ready per the spec's cross-cutting principle, and so it
  can be set directly for testing/demo purposes.
- **FR-4.** Extend the `jobs.type` CHECK (Feature 5's `jobs_type_check`,
  named per Postgres's default inline-CHECK naming) to add
  `'summarize_classify'`, exactly the extension mechanism Feature 5's
  migration comment anticipated:
  `ALTER TABLE jobs DROP CONSTRAINT jobs_type_check; ALTER TABLE jobs ADD CONSTRAINT jobs_type_check CHECK (type IN ('sync_mailbox','summarize_classify'));`
  Add `CREATE UNIQUE INDEX idx_jobs_summarize_classify_inflight ON jobs ((payload->>'emailId')) WHERE type = 'summarize_classify' AND status IN ('pending','running');`
  — the same "at most one in-flight job per subject" guarantee Feature 5
  built for `sync_mailbox`, keyed on `emailId` instead of `mailboxId`.

### 3.2 LLM module (`backend/src/llm/`, new self-contained folder)

- **FR-5.** `backend/src/llm/prompt.md` — the actual prompt template, as
  its own plain-text file (not a TS string) so it's easy to find and edit
  directly. Contains the system instructions (the three categories per the
  spec's triage model, §5) and a placeholder section for the optional
  `classification_instructions` override. The email itself (sender name,
  sender address, subject, full body) is passed as the user-turn content,
  built at call time — not baked into the file.
- **FR-6.** Response contract — a single object, produced via Mistral's
  structured/JSON-mode output constrained to this shape:
  ```ts
  interface ClassificationResult {
    summary: string; // one sentence, third person, e.g. "Pietje asks if you could review the invoice."
    category: "requires_action" | "important" | "noise";
  }
  ```
  The sender's name/address is _input_ context only (so the model can refer
  to the sender naturally, e.g. by first name) — it is never part of the
  returned object; the caller already knows it from the `emails` row.
- **FR-7.** `createLlmClassifier(config): LlmClassifier` — factory mirroring
  `backend/src/mail/index.ts`'s `createMailSender` pattern exactly:
  ```ts
  interface ClassifyInput {
    fromName: string;
    fromAddress: string;
    subject: string;
    body: string;
    classificationInstructions?: string;
  }
  interface LlmClassifier {
    name: string;
    classify(
      input: ClassifyInput,
    ): Promise<
      { ok: true; result: ClassificationResult } | { ok: false; reason: string }
    >;
  }
  ```
  - Production: requires `MISTRAL_API_KEY`; throws at construction if absent
    (same precedent as `createMailSender`'s production guard).
  - Any env with `MISTRAL_API_KEY` set: real Mistral provider
    (`backend/src/llm/mistral.ts`), `fetch`-based (no SDK dependency, same
    precedent as `resend.ts`), model from `MISTRAL_MODEL` (default
    `mistral-medium-3-5`).
  - Otherwise (dev/test, no key): `backend/src/llm/mock.ts` — a
    deterministic singleton classifier (mirrors `mockMail`'s shape/testing
    ergonomics): a simple keyword heuristic over subject + body (e.g.
    "invoice"/"payment"/"deliver" → `important`; "action"/"rsvp"/"confirm"/
    "reply"/"sign" → `requires_action`; else `noise`), with a
    truncated-subject summary. Never throws; always returns `{ ok: true }`.
  - The full email body is sent untruncated (no length cap) — a deliberate
    choice for this feature; revisit only if real usage shows a problem
    (see Open Questions).
  - A malformed/non-JSON response from the real provider is surfaced as
    `{ ok: false, reason }`, same discipline as `resend.ts`'s non-2xx
    handling — never thrown directly.

### 3.3 Queue wiring (additive to `backend/src/queue/`)

- **FR-8.** `enqueueClassifyJob(db, emailId): Promise<void>` in `store.ts`,
  same shape as `enqueueSyncJob`: `INSERT INTO jobs (type, payload) VALUES
('summarize_classify', jsonb_build_object('emailId', emailId)) ON CONFLICT
DO NOTHING`.
- **FR-9.** Classify scheduler tick — a new exported function (e.g.
  `enqueueDueClassifyJobs(db)` in `backend/src/queue/scheduler.ts`, called
  alongside the existing sync scheduler tick on the same
  `SCHEDULER_INTERVAL_MS` timer in `worker.ts` — no new env var): `SELECT id
FROM emails WHERE summary IS NULL ORDER BY received_at LIMIT 500`, then
  `enqueueClassifyJob` for each. The batch cap bounds each tick's work; a
  backlog larger than 500 is simply picked up across multiple ticks. The
  partial unique index (FR-4) absorbs the case where an email's job is
  already in flight — same non-duplicating design as the sync scheduler.
- **FR-10.** Handler (`backend/src/queue/handlers/summarize-classify.ts`):
  loads the email row (subject, body, from_name, from_address) joined to its
  mailbox's owning user (for `classification_instructions`), calls the
  configured `LlmClassifier`, and on success:
  `UPDATE emails SET summary = ..., category = ..., classified_at = now() WHERE id = ... AND summary IS NULL`
  — the `summary IS NULL` guard makes a re-run of an already-classified
  email's job a no-op instead of overwriting (idempotency). A `{ ok: false
}` result throws (routes to `failJob`, same generic retry/backoff/
  dead-letter as `sync_mailbox` — no LLM-specific retry logic, per the
  cross-cutting "one generic queue" design).
- **FR-11.** Handler dispatch map (wherever Feature 5 wired
  `sync_mailbox -> handleSyncMailboxJob`) gets a second entry:
  `summarize_classify -> handleSummarizeClassifyJob`.

### 3.4 Dashboard + new paginated feed route

- **FR-12.** `GET /api/dashboard` (`backend/src/mailboxes/dashboard.ts`):
  - `stats` becomes a real grouped count: `SELECT category, COUNT(*) FROM
emails e JOIN mailboxes m ON m.id = e.mailbox_id WHERE m.user_id = $1 AND
category IS NOT NULL GROUP BY category`, shaped as `Stats` (FR-15).
  - `emails` becomes the first page (10 rows) of the caller's
    `category = 'requires_action'` emails, newest first, in the shared
    `Email` shape (FR-15) — the same default tab `EmailList` already opens
    on. Other categories and further pages are fetched via FR-13.
- **FR-13.** New route `GET /api/emails` behind `requireAuth`: query params
  `category` (required, one of the three), `cursor` (optional, opaque
  base64 of the last row's `receivedAt`+`id`), `limit` (optional, default
  10, max 50). Keyset-paginated (`ORDER BY received_at DESC, id DESC`),
  scoped to the caller's own mailboxes only. Returns
  `{ emails: Email[]; nextCursor: string | null }` — `nextCursor` is `null`
  when the category is exhausted, which is what stops the frontend's
  infinite scroll.
- **FR-14.** `Email.needsAttention` is derived as
  `category === "requires_action"`; `suggestedAction` stays `undefined` for
  every email (the agentic action layer is explicitly deferred per the
  spec, §3's "Deferred but kept architecturally open" note).

### 3.5 Shared type + frontend vocabulary standardization

- **FR-15.** `shared/src/index.ts`: rename `Priority` → `Category`
  (`"requires_action" | "important" | "noise"`), `PRIORITY_ORDER` →
  `CATEGORY_ORDER`, `Email.priority` → `Email.category`,
  `Channel.minPriority` → `Channel.minCategory`, and `Stats` from
  `{urgent, important, everything}` to
  `{requires_action, important, noise}` (a `Record<Category, number>`, key
  names matching the category literal exactly — no translation layer
  needed anywhere the value flows).
- **FR-16.** Mechanical rename across every frontend consumer of the above
  (no behavior/design changes beyond the renamed values/labels):
  `EmailList.tsx` (`Filter` type, tab list, default active tab),
  `Dashboard.tsx`, `Hero.tsx`, `visuals.tsx` (`PRIORITY_LABEL` →
  `CATEGORY_LABEL`), `AddChannelDialog.tsx` (`minPriority` options/labels →
  `minCategory`), `EmailRow.tsx` (CSS class binding), and
  `global.css` (selector/custom-property renames:
  `.stat.urgent`/`.email.urgent`/`--urgent` → `.stat.requires_action`/
  `.email.requires_action`/`--requires-action`, etc., for every category).
- **FR-17.** Remove the not-yet-backed "Your triage instructions" textarea
  from `SettingsPanel.tsx` and the `llmInstructions` field from `Profile`/
  `profile.update()` in `frontend/src/lib/api.ts`. This feature does not add
  a user-facing settings screen for `classification_instructions` (FR-3)
  — it stays a backend-only, not-yet-editable column.
- **FR-18.** `EmailList.tsx`: infinite scroll, 10 rows per page, per active
  category tab. The default (`requires_action`) tab's first page comes from
  `DashboardData.emails` (no redundant fetch on initial load); switching
  tabs or scrolling to the bottom of the current list fetches the next page
  from FR-13's route and appends. A tab with no more pages (`nextCursor ===
null`) simply stops triggering further fetches — no "end of list" UI is
  required beyond what already exists (the empty-state fallback).

### 3.6 Config

- **FR-19.** `backend/src/config/index.ts`: add `MISTRAL_API_KEY` (secret,
  optional in dev/test, required in production — same pattern as
  `RESEND_API_KEY`) and `MISTRAL_MODEL` (default `"mistral-medium-3-5"`).
  `describeConfig` reports `MISTRAL_API_KEY` as set/not-set only (never the
  raw value) and `MISTRAL_MODEL` as its literal value (not a secret). Update
  `.env.example` with both, following the existing commented-out-by-default
  convention.

### 3.7 Tests

- **FR-20.** LLM module: mock classifier returns deterministic, expected
  categories for representative fixtures (an "invoice due" email, an
  "action needed" email, a newsletter); the real Mistral provider is tested
  against a faked `fetch` (mirroring `resend.test.ts`) for success,
  malformed-JSON, and non-2xx cases, asserting `{ ok: false, reason }` and
  no throw.
- **FR-21.** Queue: `enqueueClassifyJob` idempotency (no duplicate
  in-flight row for the same email); the handler updates `emails`
  (summary/category/classified_at) and completes the job on success; a
  classifier failure routes to `failJob` with its reason; the classify
  scheduler enqueues every `summary IS NULL` row and is a no-op for one
  already in flight; re-running a job for an already-classified email
  (summary not null) leaves the row untouched.
- **FR-22.** Dashboard: `stats` reflects real grouped counts across the
  caller's mailboxes only; `emails` returns the caller's first page of
  `requires_action` in the correct shape.
- **FR-23.** `GET /api/emails`: pagination returns a non-null `nextCursor`
  when more rows exist and `null` when exhausted; results are scoped to the
  caller's own mailboxes (no cross-user leakage); an invalid/missing
  `category` param is rejected with `400`.
- **FR-24.** End-to-end wiring test: seed an unclassified email, run one
  classify-scheduler tick + one worker tick against the mock classifier,
  assert the `emails` row gets a summary/category and the dashboard's
  `stats`/`emails` reflect it.

---

## 4. Technical Requirements

- **Language/runtime:** TypeScript, ESM, Node 22, `tsx`. Strict,
  `noUncheckedIndexedAccess`.
- **No new dependencies.** Mistral is called via `fetch` directly (same
  precedent as `resend.ts`), not the `@mistralai/mistralai` SDK.
- **New module:** `backend/src/llm/` (classifier factory, Mistral provider,
  mock, `prompt.md`, tests), self-contained per coding guidelines §2.
- **DB:** migration `0007_llm_processing.sql`, forward-only, single
  transaction.
- **New env vars:** `MISTRAL_API_KEY` (secret), `MISTRAL_MODEL` (default
  `mistral-medium-3-5`).
- **Idempotency:** `summary IS NULL` is both the work-selection predicate
  and the idempotency guard; the partial unique index (FR-4) is the
  concurrency backstop, same pattern as Feature 5's `sync_mailbox`.
- **No token/cost guardrails.** Full body sent untruncated; no cap on
  repeated Mistral failures beyond the generic 3-attempt job retry;
  deferred to Feature 13 (spec updated — see spec §3, item 13).
- **Conventional Commits:** `feat(llm): ...`.

---

## 5. Acceptance Criteria

1. **AC-1.** A newly synced email (`summary IS NULL`) is enqueued as a
   `summarize_classify` job on the next classify-scheduler tick.
2. **AC-2.** A successful classification updates the email's `summary`,
   `category`, and `classified_at`, and marks the job `succeeded`.
3. **AC-3.** A classifier failure retries at the same backoff Feature 5
   already built (1 min, then 5 min) and dead-letters on the 3rd attempt —
   no new retry code.
4. **AC-4.** Re-running a `summarize_classify` job for an already-classified
   email (summary not null) leaves the row unchanged.
5. **AC-5.** `GET /api/dashboard` returns real `stats` (grouped counts) and
   a real first page (≤10) of `requires_action` emails for the caller only.
6. **AC-6.** `GET /api/emails?category=important&cursor=...` returns the
   next page and eventually `nextCursor: null` once exhausted; it never
   returns another user's emails.
7. **AC-7.** With `MISTRAL_API_KEY` unset, the worker still classifies every
   email (via the mock) — the app is fully demoable without a real key.
8. **AC-8.** The frontend has zero remaining references to `Priority`,
   `PRIORITY_ORDER`, `PRIORITY_LABEL`, `minPriority`, or the literal values
   `urgent`/`everything` — `pnpm build` and `pnpm check:all` are green.
9. **AC-9.** The "Your triage instructions" field no longer appears in the
   Settings page.
10. **AC-10.** Scrolling to the bottom of a category tab in `EmailList`
    loads 10 more rows without a full page reload, and stops requesting
    once a tab is exhausted.

---

## 6. Open Questions

None outstanding. Resolved during PRD review:

- **OQ1 (resolved).** `classification_instructions` has no edit UI/route in
  this feature — the column exists (FR-3) so the prompt can honor it when
  present, but nothing sets it yet. A future feature (not yet numbered)
  owns the settings UI.
- **OQ2 (resolved).** No cost/failure guardrails on LLM calls in this
  feature — full body sent untruncated, generic 3-attempt retry only, a
  permanently-failing email just stays unclassified. Noted in the spec
  under Feature 13 for revisit.
- **OQ3 (resolved).** `Priority` → `Category` rename (FR-15/FR-16) is a
  deliberate vocabulary fix, not scope creep: the mock-era naming never
  matched the spec's actual three buckets, and this is the feature that
  introduces the real DB column those values must agree with.

---

## 7. Non-Goals (Out of Scope)

- **No user-facing classification-instructions UI.** The DB column exists;
  no route reads or writes it yet.
- **No LLM cost/spend guardrails or quota enforcement.** Feature 9 owns
  real tier quotas; Feature 13 owns cost/failure guardrails specific to
  LLM processing (spec updated to note this).
- **No batching multiple emails into one Mistral call.** One call per
  email, per the spec's feature description.
- **No re-classification of already-processed emails** (e.g. if the prompt
  changes later) — out of scope; would be a manual/future backfill.
- **No changes to Feature 4 (`sync/engine.ts`) or Feature 5's `sync_mailbox`
  handler.** The classify scheduler is fully additive and independent.
- **No delivery/notification of classified emails.** Feature 7 owns
  sending anything anywhere; this feature only stores the summary/category.

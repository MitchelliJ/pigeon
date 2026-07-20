# PRD — Initial Sync Progress Feedback

> Give a new user live, honest feedback in the dashboard's email list while
> Pigeon performs the first mailbox sync and LLM classification, instead of
> showing a misleading empty state.

---

## 1. Problem statement

After a user signs up and connects their first mailbox, the dashboard shows
**"Nothing here ✨ — You've cleared everything in this view."** for the one to
two minutes it takes the worker to backfill 7 days of email and the LLM to
classify it. The user gets no signal that anything is happening, cannot tell
success from failure, and may conclude the product is broken and leave. There
is likewise no feedback when the initial sync _fails_ (e.g. a wrong app
password) — the most common onboarding failure.

## 2. Known facts

- **The pipeline is asynchronous by design.** `connectMailbox`
  (`backend/src/mailboxes/service.ts`) enqueues a `sync_mailbox` job; the
  worker (`backend/src/worker.ts`) claims it within ~5 s
  (`WORKER_POLL_INTERVAL_MS`); a classify-scheduler tick enqueues
  `summarize_classify` jobs every ~60 s (`SCHEDULER_INTERVAL_MS`).
- **Unclassified emails are invisible in the UI.** Both `loadCategoryCounts`
  and `loadEmailPage` (`backend/src/emails/service.ts`) filter on
  `e.category`, so emails with `summary IS NULL` never appear.
- **Mailbox status already exists.** `mailboxes.status` is a closed enum
  (`connected | syncing | disconnected | error`, migration `0004`). The sync
  engine sets `syncing` at the start of **every** sync and `connected` at the
  end (`backend/src/sync/engine.ts`), so `status` alone cannot identify the
  _initial_ import.
- **First-sync failure sets the watermark.** `markError` in the sync engine
  sets `status = 'error'` **and** `last_synced_at = now()` on a failed first
  attempt. Consequences: (a) `last_synced_at IS NULL` does **not** mean
  "never attempted" after a failure; (b) the scheduler re-enqueues the mailbox
  on the next tier interval (~5 min), so an error state is often transient and
  the UI must tolerate phase flips `error → importing → summarizing → ready`.
- **New mailboxes are inserted with the column default `status = 'connected'`**
  — a lie until the worker first picks up the job.
- **The dashboard already polls.** `Dashboard.tsx` re-fetches
  `GET /api/dashboard` every 30 s (skipping hidden tabs). The payload is
  assembled in `backend/src/mailboxes/dashboard.ts`; the type contract is
  `DashboardData` in `@pigeon/shared`.
- **The feedback location is decided:** the filter-bar meta spot (currently
  `"{n} messages"`, `EmailList.tsx`) and the email-table area itself
  (currently the empty state). No banner, no account-card work.
- **Decisions from clarification:**
  1. Phase-only status — no counts, no progress bar, no ETA.
  2. Feedback lives in the meta line + the list area.
  3. Poll every 2 s while onboarding is unfinished; safety cap: after 10 min
     of continuously-unfinished state, fall back to 30 s.
  4. A failed initial sync gets a dedicated error state in the list area.
  5. The list-area takeover happens **only when the list would otherwise be
     empty**; if emails are already visible, only the meta line reflects
     pending work. The meta line reflects pending work at all times (not just
     first run).

## 3. Unknowns

None. All design decisions needed for implementation are resolved.

Resolved decisions:

- Copy is finalized in §4.
- The error state does not add a manual retry route; it tells the user to remove
  and re-add the mailbox with correct credentials. Existing scheduler retries
  may still happen automatically.
- The meta line stays generic and does not name a specific mailbox.
- No partial index is added for the pending-summary count in v1; revisit only
  if real query plans or production scale demand it.

## 4. Proposed solution

Derive a single **onboarding phase** server-side, expose it on the existing
dashboard payload, and let the frontend render phase-appropriate states in the
two decided locations with adaptive polling.

### Backend

1. **Truthful initial status.** `connectMailbox` inserts new mailboxes with
   `status = 'syncing'` instead of relying on the `'connected'` column
   default. No migration needed (the default only applies when the column is
   omitted).
2. **Derived phase on the dashboard payload.** Extend `DashboardData`
   (`shared/`) with:
   ```ts
   type OnboardingPhase = "importing" | "summarizing" | "error" | "ready";
   ```
   computed in `backend/src/mailboxes/dashboard.ts` with precedence
   **error > importing > summarizing > ready**:
   - `error` — the user has **zero classified emails** and at least one
     mailbox has `status = 'error'`. (Because a failed first sync sets
     `last_synced_at`, "initial" failure is defined by outcome — no classified
     mail yet — not by the watermark. The zero-classified condition also keeps
     steady-state sync errors from hijacking the onboarding UI; see §5.)
   - `importing` — at least one mailbox has `last_synced_at IS NULL` and
     `status <> 'error'` (covers both "job enqueued, not yet claimed" and
     "sync in flight").
   - `summarizing` — at least one of the user's emails has `summary IS NULL`.
   - `ready` — none of the above.
     One extra cheap `COUNT(*)` query per dashboard request (see OQ4); the
     zero-classified condition reuses the existing category-count query
     (`loadCategoryCounts` already returns all three buckets — sum them).

### Frontend

3. **Adaptive polling (`Dashboard.tsx`).** When the latest payload has
   `phase !== "ready"` and the phase has been continuously non-ready for less
   than 10 minutes, poll every **2 s**; otherwise poll every **30 s** as
   today. The 10-minute window resets whenever the phase returns to `ready`;
   a later non-ready episode (e.g. connecting a second mailbox) starts a
   fresh window. Existing behavior (skip while tab hidden, refetch on
   `visibilitychange`) is preserved.
4. **Meta line (`EmailList.tsx`).** While `phase !== "ready"`, replace
   `"{n} messages"` with generic phase text:
   - importing → "Importing your email…"
   - summarizing → "Summarizing your email…"
   - error → "Couldn't sync your mailbox"
5. **List-area states (`EmailList.tsx`).** Only when `visible().length === 0`,
   replace the empty state, with the same precedence as the phase:
   - **error** — title: "We couldn't reach your mailbox"; body:
     "Double-check the email address and app password, then remove this mailbox
     and connect it again. Pigeon also retries automatically every few minutes."
   - **importing** — title: "Importing your email…"; body: "We're fetching the
     last 7 days of email from your mailbox. This usually takes a minute or
     two."
   - **summarizing** — title: "Summarizing your email…"; body: "Pigeon is
     reading your email and writing one-sentence summaries. They'll appear here
     as they're ready."
   - **ready** — the existing "Nothing here ✨" empty state, unchanged.
     When `visible().length > 0`, the list renders normally regardless of phase
     (decision 5). The `phase` prop is threaded from `Dashboard` into
     `EmailList`.

No new endpoints, no push infrastructure, no schema migrations.

## 5. Pitfalls

- **Don't key anything off `status = 'syncing'` alone.** Routine 5-minute
  incremental syncs also set it; that would flash "Importing…" in steady
  state. The `importing` phase is defined via `last_synced_at IS NULL`, which
  incremental syncs never satisfy.
- **Failed first syncs set `last_synced_at`** (see §2). Any logic of the form
  "never synced ⇔ `last_synced_at IS NULL`" is wrong after a failure — the
  phase derivation above accounts for this; don't "simplify" it back.
- **Phase flapping on auto-retry.** A failed first sync is retried ~5 min
  later, flipping `error → importing`. This is desired (honest), but the error
  copy must not imply finality ("we'll keep retrying"), and the UI must not
  animate/jar on transitions.
- **`summarizing` in steady state.** New mail is always briefly unclassified,
  so the meta line will occasionally show "Summarizing your email…" for a
  minute in steady state. That's accepted (decision 5: meta always reflects
  pending work) — but the _list takeover_ must stay gated on an empty list so
  existing content is never hidden.
- **The 10-minute cap measures _continuously_ non-ready**, not "10 minutes
  since page load" and not cumulative. A wedged job must not cause a tab to
  poll at 2 s forever; a genuine second-mailbox import later must still get
  fast polling.
- **Seed semantics in `EmailList`.** The component seeds its default tab from
  `props.emails` once (`untrack`). Phase rendering must live outside that
  seeding logic — it's derived fresh from the latest `phase` prop on every
  poll.
- **Type contract.** `DashboardData` crosses the API boundary: change it in
  `shared/` (type-only) and let both sides import it — no parallel local
  re-declaration in the frontend.

## 6. Related problems

- **The dead `mailboxes.syncNow` route.** `frontend/src/lib/api.ts` calls
  `POST /api/mailboxes/:id/sync`, which the backend never implements. This
  feature explicitly does **not** add a manual retry route; the error state
  relies on remove/re-add plus the existing automatic scheduler retry.
- **Unclassified emails are invisible** (the "show placeholder summaries"
  alternative). If ever adopted, the `summarizing` phase largely disappears
  because content appears immediately.
- **Steady-state sync errors** (a mailbox that breaks months later) currently
  surface only via the account-card status. The phase derivation deliberately
  excludes them (zero-classified condition); a general "mailbox needs
  attention" surface could reuse the same payload field later.

## 7. Alternatives considered

- **Global banner / per-account badges** as the primary surface — rejected:
  the user watches the email list, and the empty state there is the thing
  that's wrong. Account badges already exist and stay as-is.
- **Counts / progress bar / ETA** ("Importing 120 of 340…") — rejected for v1
  (decision 1): more worker instrumentation and schema surface for marginal
  benefit; ETAs over IMAP + LLM latency would be fiction.
- **SSE/WebSocket push with Postgres LISTEN/NOTIFY** — rejected: a new
  real-time infrastructure path to improve a ~2-minute once-per-mailbox
  moment; 2 s polling during onboarding is indistinguishable in practice.
- **Synchronous first sync in `POST /api/mailboxes`** — rejected: long request
  lifetimes, timeouts on big inboxes, breaks the queue architecture, and
  classification stays async anyway so the list would still be empty.
- **Show unclassified emails immediately with a "Summarizing…" placeholder** —
  deferred as a product decision; bigger change to category semantics, and
  conflicts with "Pigeon only shows triaged mail."

## 8. User stories

1. As a new user who just connected my first mailbox, I want to see that my
   email is being imported, so that I know the product is working and I should
   wait.
2. As a new user, I want to see when import has finished and summarization is
   underway, so that I understand why the list is still empty.
3. As a new user whose mailbox credentials were rejected, I want a clear error
   where I was watching for email, so that I know to fix my credentials rather
   than conclude I have no mail.
4. As a returning user adding a second mailbox, I want the same import
   feedback, so that I'm not left wondering whether the new account worked.
5. As a user with emails already in my list, I want pending-work indicators to
   never hide my existing mail, so that background activity doesn't disrupt
   reading.

## 9. Functional requirements

- **FR-1** — `POST /api/mailboxes` creates the mailbox with
  `status = 'syncing'`.
- **FR-2** — `GET /api/dashboard` returns an `onboardingPhase` field of type
  `OnboardingPhase` (`importing | summarizing | error | ready`), derived
  server-side with precedence error > importing > summarizing > ready, per
  the definitions in §4.
- **FR-3** — While `onboardingPhase !== "ready"` and the phase has been
  continuously non-ready for < 10 min, the dashboard polls every 2 s;
  otherwise every 30 s. The 10-min window resets on return to `ready`.
  Tab-visibility skip/resume behavior is unchanged.
- **FR-4** — While `onboardingPhase !== "ready"`, the filter-bar meta line
  shows the phase text instead of `"{n} messages"`.
- **FR-5** — When the visible email list is empty and
  `onboardingPhase !== "ready"`, the list area shows the corresponding state
  (error / importing / summarizing) instead of the "Nothing here ✨" empty
  state. When the list is non-empty, it renders normally in all phases.
- **FR-6** — The error state communicates that the mailbox could not be
  reached, tells the user to remove and reconnect the mailbox with correct
  credentials, and notes automatic retry.
- **FR-7** — Phase transitions in both directions (including
  `error → importing` on auto-retry) render correctly on the next poll
  without a page reload.

## 10. Technical requirements

- Extend `DashboardData` in `shared/` (type-only contract) with
  `onboardingPhase: OnboardingPhase`; both sides import it from
  `@pigeon/shared`.
- Phase derivation lives in `backend/src/mailboxes/dashboard.ts` and is
  covered by integration tests against embedded Postgres (per guidelines:
  route/service tests boot real Postgres).
- The pending-summary check is one `SELECT COUNT(*)` scoped to the caller's
  mailboxes; the zero-classified check reuses the existing category-count
  result — no second query. Do not add a partial index in this feature.
- Polling cadence is implemented by making the existing self-rescheduling
  `setTimeout` in `Dashboard.tsx` take a computed delay; continuous-non-ready
  elapsed time is tracked in a signal/ref, not derived from wall-clock since
  mount.
- No new env vars, endpoints, migrations, or dependencies.

## 11. Acceptance criteria

1. After connecting a mailbox with valid credentials, the dashboard (without
   reload) shows "Importing…" in the list area within ~2 s of the dialog
   closing, transitions to "Summarizing…" once the sync lands, and to the
   populated list once classification completes — with the meta line tracking
   the same phases throughout.
2. The account's status never reads "connected" before its first sync
   attempt.
3. Connecting a mailbox with invalid credentials surfaces the error state in
   the list area within one poll cycle of the worker's failed attempt, and
   the state clears to "Importing…" when the automatic retry starts
   succeeding.
4. While any phase is active, network devtools show `GET /api/dashboard`
   roughly every 2 s; after 10 continuous minutes of non-ready state, the
   cadence drops to 30 s; after the phase reaches `ready`, it stays at 30 s.
5. With emails visible in the list, no phase ever replaces the list; only the
   meta line changes.
6. A steady-state incremental sync (mailbox previously synced, list possibly
   empty) never shows the "Importing…" takeover.
7. `pnpm check` and the backend test suite pass, including new integration
   tests for the phase derivation (each phase + precedence).

## 12. Open questions

None.

## 13. Non-goals (out of scope)

- Counts, progress bars, percentages, or ETAs of any kind.
- Push delivery (SSE/WebSocket/LISTEN-NOTIFY) or any new infrastructure.
- Showing unclassified email content anywhere in the UI.
- Changes to the sync engine, scheduler intervals, or classification
  pipeline.
- Steady-state "mailbox needs attention" surfacing beyond what exists today.
- The manual sync endpoint (`POST /api/mailboxes/:id/sync`).

# PRD — Sync Backfill Date Alignment

> Feature 8 of `vibes/spec-pigeon.md`. A correctness fix to Feature 4
> (Incremental Sync Engine & Watermarks): the email-selection date and the
> stored/display date must be one and the same, and the high-watermark must
> lock after first sync.

---

## 1. Problem statement

When a user connects a mailbox whose older messages were recently imported,
migrated, or dragged in, the dashboard surfaces the **oldest** emails in the
account instead of the newest — a freshly connected mailbox shows mail from
weeks or months ago while newer mail never appears.

Root cause: Pigeon uses **two different date axes** without realising it.

- **Selection** (which emails to backfill on first sync): IMAP's
  `SEARCH SINCE <date>`, which is the message's **internal date** — the
  moment the message _arrived on the server_.
- **Storage, sort, classify-enqueue, digest ranking**: the message's
  **`Date:` RFC822 header** (`emails.received_at`), written by the original
  sender.

For a normal mailbox these coincide. For an account that recently received
older mail (import, migration, backup fetch), internal date says "recent" and
the `Date:` header says "old" — so `SEARCH SINCE` returns the messages that
arrived in the last week (oldest-by-Date-header), while newer-by-Date-header
mail that arrived more than a week ago is excluded. The user sees a dashboard
ordered by `received_at DESC` full of mail from months ago.

This is an architecture smell, not just an IMAP bug: the engine's
"which emails count as in-window" decision is delegated to the connector's
choice of IMAP criteria, while every downstream consumer reads the `Date:`
header. Unless one date is canonical and the engine owns the filter, the
protocols can drift apart again.

A second, related issue compounds the bug: the high-watermark
(`last_synced_at`) is only set on full sync success. While it remains `NULL`
the scheduler re-arms a first-sync on every tick (`isDue` returns `true`
when `last_synced_at` is `NULL`), turning the historical backfill into a
forever-loop that re-runs on every failure.

## 2. Known facts

- The dashboard lists emails `ORDER BY e.received_at DESC, e.id DESC`
  (`backend/src/emails/service.ts:153`), with `received_at` set to the
  parsed `Date:` header (`backend/src/mailboxes/connectors/imap.ts:79`,
  `pop3.ts:152`).
- First-sync selection reaches back `FIRST_SYNC_LOOKBACK_MS = 7 * 24h`
  (`backend/src/sync/engine.ts:32`), gated on `last_synced_at IS NULL`
  (`engine.ts:88`).
- IMAP turns `since` into `SEARCH SINCE` server-side
  (`imap.ts:118`), which is the **internal date**, not the `Date:` header.
  The wired library `imapflow@1.4.3` routes `{ since }` to the IMAP `SINCE`
  criterion (`node_modules/.pnpm/imapflow@1.4.3/.../search-compiler.js:313`).
- POP3 has no server-side date filter; it peeks the `Date:` header via
  `TOP n 0` and filters on the **same** date it stores
  (`pop3.ts:239-247`). POP3 is therefore already correct but its filtering
  belongs in the wrong layer (connector, not engine) to stay aligned with
  IMAP.
- `connectMailbox` enqueues a `sync_mailbox` job immediately after insert
  (`backend/src/mailboxes/service.ts:95`); `enqueueSyncJob` is idempotent
  via a partial unique index `idx_jobs_sync_mailbox_inflight`
  (`backend/src/queue/store.ts:47-54`), so only one sync is inflight per
  mailbox.
- The scheduler treats a mailbox with `last_synced_at = NULL` as always due
  (PRD Feature 4), so a persistent first-sync failure currently re-enqueues
  forever.
- `last_synced_at` is the watermark already used for the spec's cross-cutting
  rule "Watermark before spend" (`vibes/spec-pigeon.md` §6, §3 capability 4).
  No second watermark column is needed.

## 3. Unknowns

- **Q1. Mailbox quota enforcement (Feature 9 not yet built).** This PRD
  fixes the date-axis bug and watermark semantics; it does not enforce any
  cap on how many emails a first sync may pull. We assume Feature 9 will add
  per-tier quota at enqueue/processing time without changing the selection
  invariant this PRD establishes.
- **Q2. Real-world incidence of internal-date vs. Date-header divergence.**
  We've confirmed it reproduces for mail that was imported post-send; we
  don't have a census of how common this is across providers. The fix is
  correctness-layer, so incidence doesn't change the design.

## 4. Proposed Solution

Make `emails.received_at` (the parsed `Date:` header) the **single canonical
email timestamp**, and make the **sync engine** the single authority that
filters by it. Connectors become pure fetchers; the engine enforces the
window.

### 4.1 One canonical date

`received_at` is the only email timestamp Pigeon reasons about. No code
filters, sorts, ranks, orders, or schedules by the IMAP internal date or any
other date. This invariant is documented in `engine.ts` and the connector
type docstrings.

### 4.2 Engine owns the cutoff, post-parse

`syncMailbox` (`backend/src/sync/engine.ts`) computes one `cutoff` value per
sync run and applies `message.receivedAt < cutoff ? skip : keep` after the
connector returns parsed messages, before insertion.

- **First sync** (`last_synced_at IS NULL`): `cutoff = now −
FIRST_SYNC_LOOKBACK_MS` (7 days, unchanged constant).
- **Incremental sync** (`last_synced_at` set):
  `cutoff = last_synced_at` (the watermark). This implements "watermark
  before spend" literally and protects against old mail imported _after_
  connect with an old `Date:` header.

`opts.since` on the connector interface is **kept** (no API churn), but
documented as an **advisory coarse pre-filter** for connectors that can
apply a server-side filter cheaply. The engine's post-parse filter is
authoritative.

### 4.3 IMAP retains `SEARCH SINCE` as a pre-filter

IMAP keeps using `SEARCH SINCE` (`imapflow`'s `{ since }`) as a coarse
server-side pre-filter to minimise bandwidth on first sync. The pre-filter
uses internal date, so it can produce **false positives** (messages whose
internal date is recent but `Date:` header is old); the engine post-parse
filter drops them deterministically. The pre-filter never produces false
negatives relative to the engine's cutoff because the divergence only
happens on import, where internal date is more recent than the `Date:`
header, so `SINCE` keeps candidates in and the engine narrows.

### 4.4 POP3 stops filtering in the connector

The POP3 connector drops its `TOP n 0` peek-and-filter (`pop3.ts:239-247`)
and its post-`RETR` `receivedAt` filter (`pop3.ts:271-273`). It still
returns every requested message; the engine filters post-parse. POP3
becomes a pure fetcher, symmetric with IMAP at the engine boundary.

### 4.5 High-watermark locks on first attempt

`syncMailbox` sets `last_synced_at = now()` **on the first attempted sync
for a mailbox, regardless of outcome** — full success, connector failure,
or empty result. This makes first sync a bounded, one-cost operation and
stops the scheduler's forever-loop.

- On full success: `status = 'connected'`, `last_synced_at = now()`
  (unchanged).
- On connector failure: `status = 'error'` (unchanged for visibility), but
  **now also** `last_synced_at = now()`. Subsequent scheduler ticks treat
  the mailbox as incremental; only newly-arrived mail is fetched.
- A user who wants the historical window retried deliberately waits for the
  per-mailbox "Sync older mail" action (out of scope here, tracked as a
  related problem in §6).

### 4.6 No UI change

The connect flow's behaviour to the user is unchanged. A mailbox whose
first sync returns zero in-window emails (because all stored mail is older
than 7 days) ends with `status = 'connected'` and the dashboard simply
shows no rows. This matches the app's ethos ("calm, done-for-you"). No
empty-state copy or status change is added.

## 5. Pitfalls

- **IMAP pre-filter false positives inflate bandwidth on import-heavy
  mailboxes.** For an account that imported years of mail recently,
  `SEARCH SINCE 7-days-ago` returns a large UID set; the connector downloads
  all of it; the engine then drops everything older than 7 days by
  `received_at`. Bandwidth on the _first_ sync of an import-heavy mailbox
  is unbounded by this PRD. Mitigation: this is a one-time cost at connect;
  ongoing bandwidth is bounded by incremental sync via the watermark. A
  future per-tier cap (Feature 9) bounds the cost further. Documented in
  `engine.ts`.
- **Incremental sync may drop legitimately new mail with a stale `Date:`
  header.** Choosing to apply the post-parse filter on every sync (not just
  first) means a message that arrives in the mailbox today but bears a
  `Date:` header older than `last_synced_at` is dropped silently. This is
  the accepted trade-off of "filter on every sync." It is rare in practice
  (legitimate senders use accurate `Date:` headers) and the alternative
  reopens the two-date-axis bug on incremental syncs. Documented in
  `engine.ts`.
- **Clock skew between sender and server.** A `Date:` header slightly older
  than `last_synced_at` due to clock skew is dropped. The 7-day first-sync
  window is wide enough that this is a non-issue on first sync; on
  incremental syncs the risk is the one above. This PRD does not add a
  skew margin — it can be retrofitted cleanly if reported.
- **Re-architecting the engine contract affects existing tests.** The
  engine test pins "engine passes `since` to the connector" and asserts on
  the watermark-on-success path. Both behaviours change (post-parse filter
  is authoritative; watermark locks on first attempt). Tests must be
  rewritten to assert the new invariants (see §9).
- **POP3 removing `TOP` peek changes its wire behaviour.** Without the peek,
  POP3 issues `RETR` for every requested id. Since POP3's `listMessageIds`
  returns _all_ UIDLs in the mailbox (no server-side filter), the
  first-sync of a large POP3 mailbox triggers a full `UIDL` + `RETR`
  stream. Bandwidth cost mirrors the IMAP concern above; the engine
  post-parse filter drops the out-of-window messages deterministically.

## 6. Related problems

- **Per-mailbox "Sync older mail" action.** A user-facing control to
  enqueue a one-shot deeper-window backfill job, gated by tier quota.
  Deferred (out of scope here) — it pairs cleanly with Feature 9's quota
  work and a deliberate UX pass. Tracked here so the design stays open.
- **Tier-dependent backfill window.** "Free = today-only, paid = N days"
  matches the spec's cross-cutting "Quotas at the edge." This PRD uses a
  fixed 7-day window; the cutoff is a single `const` in the engine and can
  be made tier-dependent cleanly in Feature 9.
- **Incremental sync of imported mail.** Filtering on every sync by the
  watermark also protects incremental syncs against old mail imported after
  connect with an old `Date:` header. Resolved as a side effect of §4.2 +
  §4.4 choosing "filter on every sync."
- **First-sync observability.** Surfacing "syncing your latest mail…" in
  the dashboard during the connect moment is a UX enhancement that prevents
  the empty-looking-feed inference. Out of scope; the `status = 'syncing'`
  row already drives any future such UI.

## 7. Alternatives considered

- **Switch IMAP to `SENTSINCE` instead of `SINCE`.** `SENTSINCE` filters by
  the message's `Date:` header server-side, the date we actually want.
  Rejected as the _whole_ fix because it leaves the architecture smell
  intact: filtering would still live in the connector, the two protocols
  could drift, and POP3 has no server-side `Date:` filter at all. Adopted
  as a _partial_ optimisation — see §4.3: IMAP could additionally switch to
  `SENTSINCE` for the pre-filter to reduce false positives, but the engine
  post-parse filter remains authoritative regardless. Implementer may pick
  `SINCE` or `SENTSINCE` for the pre-filter; the engine contract is the
  same. Recommendation: keep `SINCE` (it is the existing behaviour and
  `SENTSINCE` support varies across IMAP servers).
- **Baseline-only first sync.** Set the watermark on connect, fetch no
  history, only triage newly-arrived mail. Rejected by product decision
  (Q1 → A): preserves the current "see something after connect" feel.
- **Tier-dependent backfill window now.** Rejected by product decision
  (Q2 → A): keeps this PRD focused; the cutoff is one `const` and
  retrofittable in Feature 9.
- **Engine-only filtering, drop the IMAP pre-filter entirely.** Rejected by
  product decision (Q3 → B): the IMAP `SEARCH SINCE` server-side pre-filter
  saves bandwidth at the cost of importing false positives the engine
  drops. Keep the pre-filter; engine is authoritative.
- **Keep current watermark behaviour (set on success only).** Rejected by
  product decision (Q4 → A): forever-loop risk on persistent failures;
  watermarks must lock on first attempt.
- **Drop connectors' `opts.since` argument entirely.** Rejected by product
  decision (Q5 → A): minimal API churn; keep `opts.since` as the advisory
  pre-filter knob.
- **Filter on first sync only.** Rejected by product decision (Q6 → B):
  apply the filter on every sync to also cover incremental imports of old
  mail.
- **Use a rolling 7-day window on incremental syncs.** Rejected by product
  decision (Q7 → A): the watermark is the spec's literal "watermark before
  spend" cutoff.
- **Add a skew margin to the watermark cutoff.** Not chosen; complexity
  without a reported incident. Documented as a pitfall; retrofittable.
- **Include the "Sync older mail" user action.** Rejected by product
  decision (Q8 → B): out of scope; tracked in §6.

## 8. User Stories

- As a user connecting a mailbox that recently imported older mail, I want
  the dashboard to show my newest emails by send date (not by some hidden
  internal arrival date), so that the most recent communications are visible
  and older imports don't crowd them out.
- As a user, I want the first sync of a mailbox to be a one-time bounded
  operation, so that a flaky mail server can't cause Pigeon to re-pull and
  re-process my entire history on every retry.
- As a user, I want emails imported into my mailbox _after_ I connected to
  be triaged only if they're genuinely newer than what Pigeon has already
  seen, so that I'm not re-notified about old archive mail I dragged in.
- As an operator, I want a single canonical email timestamp echoed across
  the codebase, so that selection, sort, classify-enqueue, and digest
  ranking can never disagree about what "recent" means.

## 9. Functional Requirements

- **FR-1. Canonical timestamp.** `emails.received_at` is the single
  canonical email timestamp used for selection, sort, classify-enqueue, and
  digest ranking. No code path filters or orders by the IMAP internal date
  or any other date. Documented in a module-level comment in
  `backend/src/sync/engine.ts` and in `backend/src/mailboxes/connectors/types.ts`.
- **FR-2. Engine post-parse cutoff (first sync).** When `last_synced_at IS
NULL`, `syncMailbox` computes `cutoff = now − FIRST_SYNC_LOOKBACK_MS`
  (unchanged 7-day constant) and drops any fetched message whose
  `receivedAt < cutoff` before insertion.
- **FR-3. Engine post-parse cutoff (incremental sync).** When
  `last_synced_at` is set, `syncMailbox` computes `cutoff = last_synced_at`
  and drops any fetched message whose `receivedAt < cutoff` before
  insertion. This implements the spec's "Watermark before spend" rule.
- **FR-4. Connectors are advisory-only on `since`.** The `MailboxConnector`
  interface continues to accept `opts.since`, documented as an advisory
  coarse pre-filter; the engine's post-parse filter is authoritative.
- **FR-5. IMAP keeps `SEARCH SINCE` as pre-filter.** The IMAP connector
  continues to translate `opts.since` to `SEARCH SINCE` server-side for
  bandwidth efficiency. False positives (internal date recent, `Date:`
  header old) are dropped by the engine.
- **FR-6. POP3 stops filtering in-connector.** The POP3 connector drops
  its `TOP n 0` peek-and-filter and its post-`RETR` `receivedAt` filter.
  It returns every requested message; the engine filters post-parse.
- **FR-7. Watermark locks on first attempt.** `syncMailbox` sets
  `last_synced_at = now()` on the first sync attempt for a mailbox
  regardless of outcome — success, connector failure, or empty result.
  Connector failures continue to set `status = 'error'` for visibility; the
  watermark locks regardless.
- **FR-8. Idempotent re-runs.** Re-running `syncMailbox` for an already
  synced mailbox never inserts duplicate rows. Existing
  `ON CONFLICT (mailbox_id, provider_uid) DO NOTHING` is preserved; the
  post-parse filter is applied before insertion.
- **FR-9. No UI change.** No new empty-state copy, status badge, or
  progress surface is added by this PRD. A first sync that returns zero
  in-window emails ends with `status = 'connected'` and the dashboard
  shows no rows.
- **FR-10. Tests assert the new invariants.**
  - Engine test asserts the post-parse filter drops messages older than
    the cutoff on both first and incremental syncs.
  - Engine test asserts the watermark is set on first attempt even when
    the connector returns `{ ok: false }`.
  - Engine test no longer pins "engine passes `since` to the connector" as
    a load-bearing contract; it pins "engine applies the cutoff
    post-parse" instead.
  - IMAP connector test asserts `SEARCH SINCE` is still issued when
    `opts.since` is supplied.
  - POP3 connector test asserts `TOP n 0` is no longer issued and that
    out-of-window messages are returned to the caller (the engine drops
    them).

## 10. Technical Requirements

- No new database columns, migrations, or library dependencies. The fix
  lives in `backend/src/sync/engine.ts`,
  `backend/src/mailboxes/connectors/pop3.ts`, and their tests.
- `FIRST_SYNC_LOOKBACK_MS` constant is unchanged (`7 * 24 * 60 * 60 * 1000`).
- The engine contract for `MailboxConnector.listMessageIds` and
  `fetchMessages` is unchanged in shape (still `opts?: { since?: Date }`);
  only the docstring changes to mark `since` as advisory.
- TypeScript strict-mode conventions (`noUncheckedIndexedAccess`,
  `import type`) per coding guidelines §3.
- No new env vars, no new config, no new migrations.

## 11. Acceptance criteria

- A freshly connected mailbox whose older mail was recently imported shows
  the newest-by-`Date:`-header emails in the dashboard, not the oldest.
  Reproducible via the existing fake connector test: a first-sync returns
  messages with `receivedAt` spread across both sides of the 7-day cutoff;
  only the in-window ones are persisted.
- An incremental sync with `last_synced_at` set drops any fetched message
  whose `receivedAt < last_synced_at` before insertion. Reproducible via
  fake connector test.
- A first sync that ends in connector failure (`listMessageIds` returns
  `{ ok: false }`) leaves the mailbox row with `status = 'error'` **and**
  `last_synced_at` set to the attempt time. Subsequent scheduler ticks
  treat the mailbox as incremental (no forever-loop).
- A first sync that returns zero in-window emails ends with
  `status = 'connected'` and `last_synced_at` set.
- IMAP connector still issues `SEARCH SINCE <cutoff>` when `opts.since` is
  supplied (verified by the existing fake-IMAP-client test).
- POP3 connector no longer issues `TOP n 0` and no longer drops messages
  internally; it returns all requested messages to the engine. Verified by
  the hand-rolled POP3 fake.
- `pnpm lint && pnpm typecheck && pnpm test` passes.

## 12. Open Questions

- **OQ1.** First-sync of an import-heavy mailbox can pull a very large UID
  set through `SEARCH SINCE`; the engine post-parse filter then drops most
  of it. Should we cap the IMAP `fetch` body fetch (e.g., fetch headers
  first, parse `Date:`, filter, then `fetch` bodies only for in-window
  UIDs)? Out of scope for this PRD; documented here. Recommend deferring to
  Feature 9 (quota) or a follow-up bandwidth PRD if reported.
- **OQ2.** Confirmed at PRD drafting time: a first sync that returns zero
  in-window emails surfaces only `status = 'connected'` to the user (no
  empty-state copy). Reaffirmed during PRD review.

## 13. Non-Goals (Out of Scope)

- A per-mailbox "Sync older mail" user action and its UI.
- Tier-dependent backfill windows and quota enforcement (Feature 9).
- A first-sync progress surface in the dashboard (e.g., "Syncing your
  latest mail…").
- A clock-skew margin on the watermark cutoff.
- Switching IMAP's pre-filter to `SENTSINCE` to reduce false positives.
- OAuth-based providers (Feature 11) — the engine contract applies to them
  identically when they land; nothing here is IMAP/POP3-specific at the
  engine boundary.

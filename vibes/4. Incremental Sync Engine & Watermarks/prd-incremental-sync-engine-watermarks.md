# PRD — 4. Incremental Sync Engine & Watermarks

> Track per-mailbox what has already been seen and deduplicate so only
> genuinely new messages are ever surfaced. **Minimal scope:** an internal,
> tested `syncMailbox()` engine that fetches new messages and stores them.
> No HTTP route, no cron, no job queue — those are **Feature 5**. No
> summarization/classification — that's **Feature 6**.

---

## 1. Introduction / Overview

Feature 3 delivered a connect-mailbox flow that only ever _tests_ a
connection (`LOGIN`/`LOGOUT`, `USER`/`PASS`/`QUIT`) and never actually reads
mail. Feature 4 builds the engine that does: given a connected mailbox, fetch
whatever's new since last time, store it in Pigeon's own database, and never
re-fetch or re-process the same message twice — even across IMAP UID resets,
crashes, or repeated calls.

This is deliberately **infrastructure without a trigger**. Feature 5 (job
queue, workers, scheduler) is what will actually call `syncMailbox()` on a
cron tick per the user's plan tier. Building the engine first, as a plain
async function with its own integration tests against fake IMAP/POP3
servers, keeps the two concerns — "how do we sync one mailbox correctly" vs.
"how do we run that reliably and repeatedly for every mailbox" — cleanly
separated. `POST /api/mailboxes/:id/sync` stays `404` until Feature 5, exactly
as Feature 3's PRD called out.

Feature 3's hand-rolled IMAP client only ever needs to prove a login works;
Feature 4 needs to list messages, fetch full content, and parse MIME bodies
correctly — a different order of complexity where hand-rolling stops paying
off. This feature introduces the project's **first new runtime
dependencies**: `imapflow` (a well-maintained IMAP client) and `mailparser`
(+ `html-to-text` for HTML-only messages) for MIME decoding. POP3 stays
hand-rolled (it's a much smaller protocol) but reuses `mailparser` for body
parsing.

---

## 2. User Stories

- **As a user**, I want Pigeon to only ever show me emails once, even if it
  syncs my mailbox every few minutes, so that I never see duplicates or get
  double-notified later (Feature 7/8) for the same message.
- **As a user**, connecting a mailbox with years of history shouldn't dump
  its entire past into my triage — I want the first sync to grab only
  recent mail so day one isn't overwhelming.
- **As a developer**, I want a single, well-tested `syncMailbox()` function
  that fetches-and-stores one mailbox's new mail, independent of _when_ or
  _how often_ it's called, so Feature 5 can wrap it in a queue/cron without
  touching its internals.
- **As a developer**, I want inbox providers' fetch/list operations to sit
  behind the same connector interface Feature 3 established, so Feature 11's
  OAuth providers are additive here too, not a rewrite.
- **As a developer**, I want Pigeon's own storage (the `emails` table) to be
  the only thing every later feature (LLM classification, digest, dashboard)
  reads from — never the mail server directly — so the sync engine is the
  single seam where "provider quirks" are absorbed.

---

## 3. Functional Requirements

### 3.1 Database migration (`0005_emails.sql`)

- **`emails`** (new table)
  - `id UUID PRIMARY KEY DEFAULT gen_random_uuid()`
  - `mailbox_id UUID NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE`
  - `provider_uid TEXT NOT NULL` — the IMAP `UID` or POP3 `UIDL`, as a
    string. This is the provider's stable per-message pointer; it only ever
    needs to be compared for existence, never interpreted as an ordering.
  - `seen BOOLEAN NOT NULL DEFAULT false` — mirrors the IMAP `\Seen` flag at
    fetch time. Always `false` for POP3 (the protocol has no such flag).
  - `from_name TEXT NOT NULL`
  - `from_address TEXT NOT NULL`
  - `subject TEXT NOT NULL`
  - `body TEXT NOT NULL` — plain-text body (see FR-9).
  - `received_at TIMESTAMPTZ NOT NULL` — the message's `Date` header.
  - `created_at TIMESTAMPTZ NOT NULL DEFAULT now()` — when Pigeon ingested
    it (distinct from `received_at`).
  - **`UNIQUE (mailbox_id, provider_uid)`** — this _is_ the dedupe
    mechanism: "already synced" = "a row with this key exists." No separate
    watermark/cursor column.
  - Index on `(mailbox_id)`.
- **`mailboxes`** gains one column: `last_synced_at TIMESTAMPTZ NULL` —
  `NULL` means "never synced" (drives both the first-sync history cap, FR-8,
  and the dashboard's `lastSync`, FR-11).
- No `summary`/`priority`/`needs_attention` columns on `emails` — Feature 6
  adds those in its own migration when it starts populating them.

### 3.2 Connector interface additions (`backend/src/mailboxes/connectors/`)

- **FR-1.** `MailboxConnector` (Feature 3, `types.ts`) gains two methods
  alongside the existing `testConnection`:
  - `listMessageIds(params, opts?: { since?: Date }): Promise<{ ok: true; ids: string[] } | { ok: false; reason: string }>` —
    returns every `provider_uid` currently in the mailbox. `since` (used only
    on a mailbox's first sync, FR-8) lets IMAP filter server-side; POP3 has
    no server-side date filter and ignores `since` here (filtering happens in
    `fetchMessages`, FR-8).
  - `fetchMessages(params, ids: string[], opts?: { since?: Date }): Promise<{ ok: true; messages: FetchedMessage[] } | { ok: false; reason: string }>` —
    fetches and MIME-parses full content **only** for the requested ids
    (never re-fetches ids the caller already has stored — that filtering
    happens in the sync engine, FR-4, not the connector). `since` mirrors
    `listMessageIds`'s option and is how POP3 knows to apply its 7-day
    peek-and-filter (FR-8) — IMAP ignores it here since IMAP already
    scoped the id list via `SEARCH SINCE` at `listMessageIds` time.
  - `FetchedMessage`: `{ providerUid, fromName, fromAddress, subject, body, receivedAt, seen }`.
- **FR-2.** **IMAP is rewritten on `imapflow`**, replacing Feature 3's
  hand-rolled `imap.ts` entirely — `testConnection`, `listMessageIds`, and
  `fetchMessages` all go through the same client, so there is exactly one
  IMAP code path (no drift between "what we test" and "what we actually
  do"). `listMessageIds` uses IMAP `SEARCH` (`SINCE <date>` when `since` is
  given, else unfiltered) against `INBOX` only — no multi-folder support.
  `fetchMessages` uses `FETCH` for envelope + body + the `\Seen` flag, and
  hands the raw MIME source to `mailparser`. The `imapflow` client is taken
  behind a small injectable interface (`connect`/`getMailboxLock`/`search`/
  `fetch`/`logout` — just the slice `imap.ts` actually calls), defaulting to
  the real library in production. **Why:** a purpose-built fake IMAP server
  for tests (`hoodiecrow-imap`) is deprecated/unmaintained, and the
  maintained alternative (WildDuck) requires MongoDB — a stateful service
  the project's single-box constraint rules out. Since protocol correctness
  is now `imapflow`'s responsibility (that's the point of adopting it —
  Feature 3 explicitly decided hand-rolling was too error-prone once real
  FETCH/UID handling was needed), tests exercise `imap.ts`'s own logic
  (since-filtering, id-diffing, error mapping) against an in-memory fake
  implementing that same narrow client interface, not a real socket.
- **FR-3.** **POP3 stays hand-rolled**, extended with `LIST`/`UIDL` (for
  `listMessageIds`) and `RETR`/`TOP` (for `fetchMessages`), reusing
  `mailparser` for MIME decoding of whatever `RETR` returns.
- **FR-4.** If a POP3 server doesn't support `UIDL` (some reply `-ERR` to
  the bare `UIDL` command), `listMessageIds` resolves
  `{ ok: false, reason: "uidl_not_supported" }` — never falls back to
  sequence-number-based tracking (unsafe: server-side deletions shift
  numbering, which could silently skip new mail or silently re-notify old
  mail).
- **FR-5.** No handling of an IMAP `UIDVALIDITY` reset. If a provider
  renumbers UIDs, every existing message appears "new" under a fresh
  `provider_uid` on the next sync and gets re-ingested (and later
  re-processed by Feature 6). This is a known, accepted failure mode — not
  detected, not guarded against, not surfaced specially to the user.

### 3.3 Sync engine (`backend/src/sync/`, new self-contained folder)

- **FR-6.** `syncMailbox(db, vault, connector, mailboxId): Promise<SyncResult>`
  is the single entry point, where
  `SyncResult = { ok: true; inserted: number } | { ok: false; reason: string }` —
  `inserted` is the count of new `emails` rows actually written this run
  (`0` on a no-op incremental sync), giving Feature 5's worker something
  machine-readable to log/retry on without inventing its own shape later.
  No HTTP route, no queue registration — a plain, directly callable async
  function with its own integration tests. Steps:
  1. Load the mailbox row; `vault.open()` the stored credential.
  2. Set `status = 'syncing'`.
  3. `listMessageIds(...)` — pass `since = now() - 7 days` only when
     `last_synced_at IS NULL` (first sync, FR-8); otherwise unfiltered.
  4. Diff the returned ids against `SELECT provider_uid FROM emails WHERE mailbox_id = $1` —
     compute the new subset.
  5. `fetchMessages(...)` for the new subset only.
  6. `INSERT INTO emails (...) ... ON CONFLICT (mailbox_id, provider_uid) DO NOTHING` —
     the idempotency backstop (FR-7) in addition to the pre-filtered diff.
  7. On success: `status = 'connected'`, `last_synced_at = now()`.
  8. On any connector-level failure (including FR-4's `uidl_not_supported`,
     connection errors, timeouts): `status = 'error'`, `last_synced_at`
     **unchanged**, no partial rows committed for that run.
- **FR-7.** **Idempotent and safe under repeated/concurrent calls** for the
  same mailbox: re-running `syncMailbox()` (or two overlapping calls, before
  Feature 5 adds serialization) never double-inserts, because of the unique
  constraint + `ON CONFLICT DO NOTHING`. No explicit locking is added in
  this feature — Feature 5's job queue owns serializing sync attempts per
  mailbox.
- **FR-8.** **First-sync history cap: 7 days**, not configurable in this
  feature (a flat constant in code, not an env var).
  - IMAP: enforced server-side via `SEARCH SINCE`.
  - POP3 (no server-side date filter exists): `listMessageIds` returns
    every id as usual; `fetchMessages`, when called for a first sync, uses
    `TOP <n> 0` to peek at headers only, discards ids whose `Date` header
    falls outside the last 7 days, and only issues `RETR` (full body) for
    the rest. If a POP3 server doesn't support `TOP` either (rare, rarer
    than missing `UIDL`), fall back to `RETR`-then-filter for the first
    sync only (fetches full bodies for old mail just to discard them once —
    an accepted inefficiency for a rare, one-time cost).
- **FR-9.** **Plain-text body extraction**: prefer `mailparser`'s parsed
  `.text`; if a message has no plain-text part (HTML-only), derive one from
  the HTML part via `html-to-text`. Matches `shared.Email.body`'s existing
  contract ("full plain-text body").
- **FR-10.** No size limit or truncation on `emails.body` in this feature.

### 3.4 Dashboard updates (`backend/src/mailboxes/dashboard.ts`)

- **FR-11.** `lastSync` becomes real: `MAX(mailboxes.last_synced_at)` across
  the caller's mailboxes, formatted as a short relative string (e.g. `"2m
ago"`, `"1h ago"`, `"3d ago"`) via a small new local helper (no existing
  formatter in the codebase to reuse). `"Never"` when the user has no
  mailboxes or none has ever completed a sync.
- **FR-12.** `accounts[].unread` becomes real, **computed on read** (not a
  stored counter, to avoid drift): `SELECT COUNT(*) FROM emails WHERE
mailbox_id = $1 AND seen = false`, one query per mailbox (or a single
  grouped query across all the caller's mailboxes). POP3-protocol mailboxes
  always report `0` (no server-side read/unread concept exists to mirror).
- **FR-13.** `emails: []` **stays a placeholder** — `shared.Email` requires
  `summary`/`priority`/`needsAttention`, which don't exist until Feature 6.
  Feature 4 does not touch this field.
- **FR-14.** `stats`, `channels`, `digest` remain untouched placeholders
  (Features 6/7).

### 3.5 Dependencies (`backend/package.json`)

- **FR-15.** Add `imapflow`, `mailparser`, `html-to-text` (+ `@types/mailparser`
  if not bundled) as new runtime dependencies. First departure from
  Features 1–3's "no new npm dependency" rule — flagged and expected by
  Feature 3's own PRD.

### 3.6 Tests (`backend/src/sync/test/`, `backend/src/mailboxes/connectors/test/`)

- **FR-16.** **POP3**: extend Feature 3's fake TLS POP3 server fixture
  (today only `USER`/`PASS`/`QUIT`) to also respond to `LIST`, `UIDL`,
  `TOP`, and `RETR` with scripted fixture messages (including at least one
  HTML-only message and one older-than-7-days message) — this protocol
  stays hand-rolled by Pigeon, so it stays tested against a real fake
  socket, per the existing pattern.
- **FR-16b.** **IMAP**: no fake server. `imap.ts`'s tests inject a fake
  implementation of the small client interface (FR-2) — an in-memory
  object scripted to return given UIDs/messages/flags — verifying
  `imap.ts`'s own since-filtering, id-diffing, and error-mapping logic,
  not wire-level IMAP correctness (that's `imapflow`'s own test suite's
  job).
- **FR-17.** Connector-level tests: `listMessageIds`/`fetchMessages` for
  both protocols return correct ids/content against their respective test
  doubles; POP3 without `UIDL` resolves
  `{ ok: false, reason: "uidl_not_supported" }`.
- **FR-18.** Engine-level integration tests (embedded Postgres, fake
  connector or fake servers): first sync only ingests messages within 7
  days; a second `syncMailbox()` call with no new server-side mail inserts
  zero new rows; a second call with genuinely new mail ingests only the
  new messages; calling `syncMailbox()` twice concurrently (or twice in a
  row) never produces duplicate rows for the same `provider_uid`; a
  connector failure mid-sync leaves `status = 'error'` and does not update
  `last_synced_at`; `emails.body` for an HTML-only fixture message is
  non-empty plain text.
- **FR-19.** Dashboard tests: seed `emails` rows with a mix of
  `seen`/unseen, assert `accounts[].unread` matches; seed `last_synced_at`
  on multiple mailboxes, assert `lastSync` reflects the most recent one and
  is a plausible relative string.

---

## 4. Technical Requirements

- **Language/runtime:** TypeScript, ESM, Node 22, `tsx`. Strict,
  `noUncheckedIndexedAccess`.
- **New dependencies** (first exception to the "no new npm dependency"
  rule): `imapflow`, `mailparser`, `html-to-text`. Still no ORM — hand-written
  SQL throughout.
- **New module:** `backend/src/sync/` (engine + tests), self-contained per
  coding guidelines §2. Extends (does not replace) `backend/src/mailboxes/connectors/`
  for the connector interface itself.
- **DB:** migration `0005_emails.sql`, forward-only, single transaction.
- **No HTTP route, no queue, no cron** in this feature. `syncMailbox()` is
  called directly from tests only until Feature 5 exists.
- **Idempotency:** unique constraint + `ON CONFLICT DO NOTHING` is the
  correctness backstop; the pre-diff (FR-6 step 4) is the bandwidth
  optimization — both matter, neither alone is sufficient.
- **Conventional Commits:** `feat(sync): ...`.

---

## 5. Acceptance Criteria

1. **AC-1.** Calling `syncMailbox()` against a real (or fixture) IMAP
   mailbox with 3 new messages inserts exactly 3 new `emails` rows, each
   with correct `from_name`/`from_address`/`subject`/`body`/`received_at`.
2. **AC-2.** Calling `syncMailbox()` a second time with no new server-side
   mail inserts zero rows and leaves the table unchanged.
3. **AC-3.** A mailbox's **first** sync against a fixture containing
   messages both inside and outside the last 7 days only ingests the
   ones inside that window (verified for both IMAP and POP3 fixtures).
4. **AC-4.** A POP3 fixture server that rejects `UIDL` causes `syncMailbox()`
   to set `status = 'error'` and insert zero rows — never falls back to
   count/order-based tracking.
5. **AC-5.** Two overlapping/rapid `syncMailbox()` calls for the same
   mailbox never produce two rows for the same `provider_uid` — verified
   by a `UNIQUE (mailbox_id, provider_uid)` violation being impossible to
   trigger (caught by `ON CONFLICT DO NOTHING`), not just "unlikely."
6. **AC-6.** A connector failure (bad credentials no longer valid,
   connection refused, timeout) leaves the mailbox `status = 'error'` and
   `last_synced_at` unchanged from before the attempt.
7. **AC-7.** An HTML-only fixture message is stored with a non-empty,
   readable plain-text `body` (derived via `html-to-text`).
8. **AC-8.** `GET /api/dashboard`'s `accounts[].unread` reflects a live
   `COUNT` of `seen = false` rows per mailbox (IMAP), and is always `0` for
   POP3-protocol mailboxes.
9. **AC-9.** `GET /api/dashboard`'s `lastSync` reflects the most recent
   `mailboxes.last_synced_at` across the caller's mailboxes as a relative
   string, and is `"Never"` when none has synced.
10. **AC-10.** `POST /api/mailboxes/:id/sync` still returns `404` — this
    feature adds no route.
11. **AC-11.** `pnpm check:all` is green, including new `sync`/extended
    `mailboxes` connector integration tests (embedded Postgres, fake
    IMAP/POP3 test servers extended for listing/fetching, no real network).

---

## 6. Open Questions

- **OQ1.** Is a flat 7-day first-sync cap right for every plan tier, or
  should higher tiers (Pro/Team) get a longer initial window (or fetch
  everything) since they're presumably paying for more coverage? Leaning
  **flat 7 days for everyone in this feature** — tier-differentiated sync
  _behavior_ (not just frequency) feels like a Feature 9 (quota/tiers)
  concern layered on top later, not something to bake into the engine now.
- **OQ2.** `emails.body` has no size cap — a handful of pathological huge
  messages (large quoted threads, base64 blobs mis-parsed as text) could
  bloat storage. Worth a practical cap (e.g. truncate at N KB) now, or
  defer until it's an actual observed problem?
- **OQ3.** Rare POP3 servers lacking `TOP` fall back to fetching-then-discarding
  full bodies during the first sync only (FR-8) — acceptable one-time cost,
  or should that case also just hard-error like missing `UIDL` (FR-4), for
  consistency?

---

## 7. Non-Goals (Out of Scope)

- **No HTTP route, cron, or job queue.** `syncMailbox()` is an internal
  function only; wiring it to run on a schedule is Feature 5.
- **No LLM summarization/classification.** `emails` stores raw content only;
  `summary`/`priority`/`needs_attention` are Feature 6's columns to add.
- **No `dashboard.emails` population.** Stays `[]` until Feature 6 can
  supply the fields the shared `Email` type requires.
- **No IMAP `UIDVALIDITY` reset handling.** A provider-side UID renumbering
  causes silent re-ingestion/re-processing of previously-seen mail — an
  accepted failure mode, not detected or mitigated.
- **No multi-folder IMAP sync.** `INBOX` only.
- **No explicit per-mailbox locking/serialization.** Idempotency relies on
  the unique constraint; Feature 5 owns preventing genuinely concurrent
  syncs of the same mailbox at the job-scheduling level.
- **No stuck-sync recovery.** If a process crashes mid-sync, the mailbox
  can be left at `status = 'syncing'` indefinitely — Feature 5's job queue
  owns timeout/retry semantics.
- **No message deletion sync** (a message removed from the server after
  being ingested stays in Pigeon's `emails` table forever, until some later
  feature explicitly addresses it).
- **No attachments** — MIME parsing extracts the plain-text body only;
  attachment content/metadata is discarded.
- **No OAuth providers** (Gmail/Microsoft) — Feature 11, additive to the
  same `MailboxConnector` interface.
- **No new stateful infrastructure** (still just Postgres) beyond the two
  new npm dependencies already called out.

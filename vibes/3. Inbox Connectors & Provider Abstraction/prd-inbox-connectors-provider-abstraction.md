# PRD — 3. Inbox Connectors (IMAP/POP3) & Provider Abstraction

> Offer a connect-mailbox flow with connection testing and encrypted
> credential storage behind a provider-agnostic interface ready for OAuth
> later. **Minimal scope:** connect, test, store, list, and remove a mailbox.
> Actually fetching/syncing messages is **Feature 4** (Incremental sync engine
> & watermarks); OAuth-based providers are **Feature 11**.

---

## 1. Introduction / Overview

This is the third walking-skeleton feature. It mounts onto Feature 1
(Postgres, migrations, config) and Feature 2 (`users`, `requireAuth`) and
delivers the first piece of real product surface: connecting an email
account.

The mock frontend already declares the full contract this feature makes
real — `shared/src/index.ts` has `Provider`/`EmailAccount`, `api.ts` has
`mailboxes.create/remove/syncNow`, and `AddInboxDialog.tsx` +
`frontend/src/lib/providers.ts` already render a two-step "pick a provider →
enter credentials" flow with correct per-provider IMAP/POP3 host/port
defaults. Feature 3's job is to stand up the backend behind that contract:

1. **A `mailboxes` table** scoped to `user_id`, storing connection details and
   an **encrypted** credential (never plaintext at rest).
2. **A `vault` module** (`backend/src/vault/`) — AES-256-GCM sealing keyed by
   `VAULT_MASTER_KEY` — the first user of the encrypted-secrets convention the
   coding guidelines call for; every later feature that stores a secret
   (OAuth tokens, channel webhooks, Mollie keys) reuses it.
3. **A provider-agnostic connector interface** — `testConnection(params)` —
   with hand-rolled minimal IMAP and POP3 implementations. "Provider-agnostic"
   means the interface, not the wire protocol: Feature 11 adds
   `gmail-oauth`/`microsoft-oauth` connectors behind the same shape without
   touching the `mailboxes` table or the routes.
4. **`POST /api/mailboxes`** (test + create) and **`DELETE
/api/mailboxes/:id`**, both behind `requireAuth`.
5. **`GET /api/dashboard`** — this is the first feature to stand up this
   route at all. It returns real `user` + `accounts`; `stats`, `emails`,
   `channels`, and `digest` are explicit placeholders owned by Features 4, 6,
   and 7, which will edit this same handler to replace them. This is what
   lets `Dashboard.tsx`/`Sidebar.tsx`/`AddInboxDialog.tsx` — already built —
   actually run end-to-end today instead of 404ing.
6. **A trivial `GET /api/oauth/providers`** stub (`200 { providers: [] }`) so
   the OAuth buttons in `AddInboxDialog` (which already degrade gracefully)
   have a real endpoint instead of a dangling one. Feature 11 replaces the
   body.

**What this is _not_:** no message fetching/parsing, no sync watermarks, no
job queue, no real OAuth, no demo/"mock" mailbox, no mailbox-count quota
enforcement, no editing a mailbox's credentials (delete + re-add instead).

---

## 2. User Stories

- **As a user**, I want to pick my email provider (Gmail, Outlook, iCloud,
  Fastmail, or "other IMAP/POP3") and enter my address + app password, so
  that Pigeon can connect to my inbox.
- **As a user**, I want the connect flow to actually **test** the connection
  before saving it, so that a typo'd password or host fails immediately with
  a clear error instead of silently creating a broken mailbox.
- **As a user**, I want my email password stored encrypted, never in
  plaintext, so that a database leak doesn't expose my mailbox credentials.
- **As a user**, I want to see my connected mailboxes with their status, so
  that I know Pigeon is set up correctly.
- **As a user**, I want to remove a connected mailbox, so that I can
  disconnect an account I no longer want triaged.
- **As a developer**, I want inbox providers to sit behind one interface, so
  that adding Gmail/Microsoft OAuth later (Feature 11) doesn't touch the
  `mailboxes` table, the routes, or the frontend contract.
- **As a developer**, I want a general-purpose `vault` module for sealing
  secrets at rest, so that every later feature (OAuth tokens, channel
  webhooks, payment keys) reuses one reviewed implementation instead of
  reinventing encryption.
- **As a developer**, I want `GET /api/dashboard` stood up now with clearly
  marked placeholders for not-yet-built data, so the existing frontend runs
  against a real backend today and each later feature has an obvious,
  single place to fill in its slice.

---

## 3. Functional Requirements

### 3.1 Backend module: `backend/src/vault/`

- **FR-1.** `seal(plaintext: string): string` / `open(sealed: string):
string`. AES-256-GCM via `node:crypto`. `seal` generates a random 12-byte IV,
  encrypts, and returns `gcm:ivBase64:authTagBase64:ciphertextBase64`. `open`
  parses that format, verifies the auth tag, and throws on tamper/format
  mismatch or wrong key.
- **FR-2.** The key is `VAULT_MASTER_KEY` from config: base64, must decode to
  exactly 32 bytes. Parsed once at startup (see §3.4); the module never reads
  `process.env` directly, matching the config module's fail-fast convention.
- **FR-3.** No other module reaches into `node:crypto` for secret-at-rest
  encryption — `vault` is the single point other features seal/open through.

### 3.2 Backend module: `backend/src/mailboxes/`

A self-contained folder: routes, connector interface + implementations, SQL,
and types together, per coding guidelines §2.

#### 3.2.1 Database table (new migration `0004_mailboxes.sql`)

- **`mailboxes`**
  - `id UUID PRIMARY KEY DEFAULT gen_random_uuid()`
  - `user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE`
  - `provider TEXT NOT NULL CHECK (provider IN ('gmail','outlook','icloud','fastmail','imap','mock'))`
    — mirrors `shared.Provider`; `'mock'` is a valid DB value for forward
    compatibility but the API rejects it today (FR-6).
  - `protocol TEXT NOT NULL CHECK (protocol IN ('imap','pop3','mock','gmail-oauth','microsoft-oauth'))`
    — mirrors `shared.EmailAccount.protocol`; only `'imap'`/`'pop3'` are
    reachable through this feature's routes.
  - `label TEXT NOT NULL`
  - `address CITEXT NOT NULL` — the mailbox's email address.
  - `host TEXT NOT NULL`
  - `port INTEGER NOT NULL`
  - `tls BOOLEAN NOT NULL DEFAULT true`
  - `username TEXT NOT NULL` — not always the same as `address` (some
    providers use a separate login name).
  - `password_ciphertext TEXT NOT NULL` — vault-sealed app password. Never
    plaintext.
  - `status TEXT NOT NULL DEFAULT 'connected' CHECK (status IN ('connected','syncing','disconnected','error'))`
    — this feature only ever writes `'connected'` (on a successful test); the
    other three values exist so Features 4/5 don't need a migration to widen
    the constraint.
  - `created_at TIMESTAMPTZ NOT NULL DEFAULT now()`
  - `updated_at TIMESTAMPTZ NOT NULL DEFAULT now()`
  - `UNIQUE (user_id, address)` — connecting the same address twice is a
    mistake, not a use case; re-adding after a delete is unaffected since the
    old row is gone.
  - Index on `(user_id)`.

#### 3.2.2 Connector interface (`backend/src/mailboxes/connectors/`)

- **FR-4.** A `MailboxConnector` shape:
  `testConnection(params: { host: string; port: number; tls: boolean;
username: string; password: string }): Promise<{ ok: true } | { ok: false;
reason: string }>`. Never throws for expected failure modes (bad
  credentials, connect timeout, TLS failure, DNS failure) — those resolve to
  `{ ok: false, reason }`.
- **FR-5.** **Hand-rolled minimal clients**, no new npm dependency:
  - `imap.ts`: opens a TLS socket (`node:tls`, implicit TLS — no STARTTLS),
    sends `a1 LOGIN <username> <password>`, reads until it sees the tagged
    `a1 OK`/`a1 NO`/`a1 BAD` response, then `a2 LOGOUT` and closes. `OK` →
    success; `NO`/`BAD` → `{ ok: false, reason: "authentication failed" }`.
  - `pop3.ts`: opens a TLS socket, sends `USER <username>` (expects `+OK`),
    then `PASS <password>` (expects `+OK`), then `QUIT`. A `-ERR` on either
    step → `{ ok: false, reason: "authentication failed" }`.
  - Both apply a **10-second connect+auth timeout**; a timeout or any socket
    error (ECONNREFUSED, ENOTFOUND, TLS handshake failure) resolves to
    `{ ok: false, reason: "could not reach <host>:<port>" }` (message doesn't
    leak stack traces or raw protocol text to the client).
  - **Strict TLS validation** — no `rejectUnauthorized: false` in the public
    code path. A self-signed/expired/mismatched certificate is a connection
    failure like any other. (Test-only override, §3.5.)
  - Only `'imap'`/`'pop3'` connectors exist today; the module exports a
    `getConnector(protocol)` lookup so Feature 11 adds
    `'gmail-oauth'`/`'microsoft-oauth'` entries without touching callers.

#### 3.2.3 Connect a mailbox (`POST /api/mailboxes`)

- **FR-6.** Body (already declared in `api.ts`): `{ provider, protocol,
label, address, host, port, tls, username, password }`. Validate with Zod:
  `provider` ∈ `gmail|outlook|icloud|fastmail|imap` (**`mock` is rejected**,
  `400 { code: "provider_not_supported" }`); `protocol` ∈ `imap|pop3`; `tls`
  must be `true` (`false` → `400 { code: "tls_required" }` — implicit TLS
  only, no STARTTLS/plaintext); `address` a plausible email; `label` 1–200
  chars, trimmed; `host` non-empty; `port` 1–65535; `username`/`password`
  non-empty.
- **FR-7.** Run `getConnector(protocol).testConnection({ host, port, tls,
username, password })`.
  - Failure → `422 { error: reason, code: "connection_failed" }`. **No row is
    persisted.**
  - Success → `vault.seal(password)`, `INSERT INTO mailboxes` with
    `status='connected'`, respond `201 { mailbox: EmailAccount }` (`id`,
    `provider`, `label`, `address`, `protocol`, `status`, `unread: 0` —
    `unread` is always `0` until Feature 4 populates real counts).
- **FR-8.** A duplicate `(user_id, address)` → `409 { code:
"mailbox_already_connected" }` (the connection test still runs first, since a
  stale duplicate check without the test would be confusing; the unique
  constraint is the backstop, the check-then-test order avoids testing
  credentials that will just be rejected — service code checks for the
  existing row before calling the connector).

#### 3.2.4 Remove a mailbox (`DELETE /api/mailboxes/:id`)

- **FR-9.** `requireAuth`; the row must belong to `ctx.user.id` — if it
  doesn't exist or belongs to someone else, respond `404` (never `403`, to
  avoid confirming another user's mailbox exists). On match: hard delete the
  row (credential ciphertext is gone with it). Respond `200 { ok: true }`.

#### 3.2.5 `GET /api/dashboard` (new, thin aggregator)

- **FR-10.** `requireAuth`. Assembles `DashboardData`:
  - `user`: `{ name, email, plan }` from `ctx.user`; `plan` is derived from
    `tierLimits(ctx.user.tier)` (`shared`) — `name`, `price` (null on free),
    `inboxLimit: maxMailboxes`, `nextBillingDate: null`, `canUpgrade: tier !==
"team"`. No billing data exists yet (Feature 10); this is a cheap, honest
    derivation from the tier the user already has.
  - `accounts`: real `SELECT * FROM mailboxes WHERE user_id = $1 ORDER BY
created_at`, mapped to `EmailAccount[]`.
  - `stats: { urgent: 0, important: 0, everything: 0 }` — **placeholder,
    owned by Feature 6.**
  - `emails: []` — **placeholder, owned by Feature 4/6.**
  - `channels: []` — **placeholder, owned by Feature 7.**
  - `digest: { enabled: false, time: "08:00", days: [], channelId: "",
lastSent: "Never" }` — **placeholder, owned by Feature 7.**
  - `lastSync: "Never"` — **placeholder, owned by Feature 4.**
  - Each placeholder is a one-line code comment naming the feature that
    replaces it, so nobody mistakes it for finished behavior.

#### 3.2.6 `GET /api/oauth/providers` (new, trivial stub)

- **FR-11.** `requireAuth` not required (the connect dialog calls this before
  a mailbox exists, but the user is already authenticated to see the
  dialog at all — mount behind `requireAuth` for consistency with every
  other Feature-3-and-later route). Always responds `200 { providers: [] }`.
  Feature 11 replaces the body with real Google/Microsoft OAuth app
  discovery; `/api/oauth/:id/start` remains unimplemented (404) until then.

### 3.3 Frontend (`frontend/`)

- **FR-12.** Remove the `"mock"` entry from `PROVIDERS` in
  `frontend/src/lib/providers.ts` (no longer a selectable option — FR-6
  rejects it server-side, so it shouldn't be offered). Remove the
  `provider() !== "mock"` special-casing in `AddInboxDialog.tsx` that exists
  only to hide fields for the mock provider (protocol picker, host/port
  fields, and the `tls`/`host` overrides in `submit()` are always shown /
  always real now).
- **FR-13.** No other frontend changes: `mailboxes.create`'s request shape in
  `api.ts` already matches FR-6 exactly, `Sidebar.tsx`'s remove call already
  matches FR-9, and `Dashboard.tsx`'s `fetchDashboard()` already matches
  FR-10. `ApiError` already renders inline in `AddInboxDialog`, so a
  `422 connection_failed` surfaces as-is.
- **FR-14.** No frontend unit tests (coding guidelines §2); `pnpm build` is
  the frontend gate.

### 3.4 Config (`backend/src/config/`)

- **FR-15.** Extend the Zod schema with `VAULT_MASTER_KEY`: **required in
  every environment** (dev/test/prod — mailboxes always store an encrypted
  secret, there's no "mock provider" path to fall back to per FR-6). Must be
  valid base64 decoding to exactly 32 bytes; otherwise the process crashes at
  startup naming the variable (consistent with Feature 1/2's fail-fast
  rule). Test setup uses a fixed, committed test key (not a real secret —
  it seals nothing sensitive in CI).
- **FR-16.** `.env.example` gains `VAULT_MASTER_KEY` (commented, with the
  existing `.env.old` generation snippet: `node -e
"console.log(require('crypto').randomBytes(32).toString('base64'))"`).

### 3.5 Tests (`backend/src/mailboxes/test/`, `backend/src/vault/test/`)

- **FR-17.** `vault`: seal/open round-trips the original plaintext; a
  flipped byte in the ciphertext or auth tag fails to open; opening with a
  different key fails; `seal` output never appears verbatim in `open`'s
  input parsing errors (no plaintext leakage in error messages).
- **FR-18.** Connectors: integration tests spin up **real local fake
  IMAP/POP3 servers** (`node:tls`/`node:net`, a committed self-signed test
  certificate) implementing just enough protocol to accept a correct
  login and reject a wrong one. Connector functions accept the target
  host/port and (test-only, not part of the public request shape) a TLS
  options override so tests can trust the fixture's self-signed cert
  without weakening the production code path. Cover: successful login,
  wrong password, connection refused (nothing listening), and a timeout
  (a socket that never responds).
- **FR-19.** Routes: boot the embedded-Postgres harness, apply migrations.
  Tests inject a fake connector (success/failure) to avoid real network.
  Cover: create with a passing test → `201`, row persisted with
  `password_ciphertext` set (assert it's not the plaintext password and
  round-trips through `vault.open`); create with a failing test → `422`, **no
  row persisted**; duplicate `(user, address)` → `409`; `provider: "mock"` →
  `400`; `tls: false` → `400`; delete own mailbox → `200`, row gone; delete
  someone else's mailbox id → `404`; `GET /api/dashboard` reflects real
  `accounts` and correctly-shaped placeholders for the rest;
  `GET /api/oauth/providers` → `200 { providers: [] }`; every route without
  a session cookie → `401`.

---

## 4. Technical Requirements

- **Language/runtime:** TypeScript, ESM, Node 22, `tsx`. Strict,
  `noUncheckedIndexedAccess`.
- **No new workspaces, no new npm dependencies.** `vault` and `mailboxes` are
  folders under `backend/src/`. Connectors are hand-rolled over `node:tls` —
  no `imapflow`/`node-imap`/`poplib`. Revisit the dependency decision in
  Feature 4, which needs full protocol support (listing/fetching/UID
  handling) that a login-test doesn't.
- **Crypto:** `node:crypto` `createCipheriv('aes-256-gcm', ...)` /
  `createDecipheriv`, 32-byte key from `VAULT_MASTER_KEY`, random 12-byte IV
  per seal. No new crypto dependency.
- **DB:** hand-written SQL, co-located with `mailboxes/`. Migration
  `0004_mailboxes.sql`, forward-only, single transaction (Feature 1's
  runner).
- **`requireAuth` on every route** in this feature, reused unchanged from
  Feature 2.
- **`GET /api/dashboard` is a thin aggregator, not a `mailboxes/`-owned
  concern long-term** — it lives wherever is simplest today (co-located with
  `mailboxes/` since that's the only real data source) and every later
  feature (4, 6, 7) edits this same handler to replace its placeholder. Note
  this explicitly in the handler's module comment so it doesn't read as
  permanently owned by inbox connectors.
- **Module-doc convention:** `vault/` and `mailboxes/` each start with a
  block comment (what + why), per coding guidelines §3.
- **Conventional Commits:** `feat(vault): ...`, `feat(mailboxes): ...`.

---

## 5. Acceptance Criteria

1. **AC-1.** A user can connect a real IMAP mailbox: submitting valid
   host/port/username/password through `POST /api/mailboxes` runs a live
   connection test, persists the mailbox with an encrypted password, and
   returns `201` with an `EmailAccount`-shaped body.
2. **AC-2.** A wrong password or unreachable host returns `422
connection_failed` and **persists nothing** — verified by an integration
   test asserting the `mailboxes` table row count is unchanged.
3. **AC-3.** The stored password is never plaintext: an integration test
   reads `password_ciphertext` directly and asserts it does not equal the
   submitted password, and that `vault.open()` recovers the original.
4. **AC-4.** `provider: "mock"` and `tls: false` are both rejected with
   `400` before any connection attempt.
5. **AC-5.** Connecting the same `(user, address)` twice returns `409`.
6. **AC-6.** `DELETE /api/mailboxes/:id` removes a user's own mailbox
   (`200`, gone from a subsequent `GET /api/dashboard`) and returns `404`
   for a mailbox belonging to another user.
7. **AC-7.** `GET /api/dashboard` returns real `user` and `accounts` (backed
   by the DB) and correctly-shaped placeholder `stats`/`emails`/`channels`/
   `digest`/`lastSync` — the frontend `Dashboard.tsx` renders without error
   against this response.
8. **AC-8.** `GET /api/oauth/providers` returns `200 { providers: [] }`; the
   existing `AddInboxDialog` OAuth section stays hidden (empty list).
9. **AC-9.** Every route in this feature returns `401` without a valid
   session cookie.
10. **AC-10.** Starting the API without `VAULT_MASTER_KEY`, or with a
    malformed one (wrong length/not base64), exits non-zero before binding,
    naming the variable — in every `NODE_ENV`, not just production.
11. **AC-11.** `pnpm check:all` is green, including new `vault`/`mailboxes`
    integration tests (embedded Postgres, fake IMAP/POP3 test servers, no
    real network). `pnpm build` (frontend) is green, with `"mock"` removed
    from the provider grid.
12. **AC-12.** End-to-end: with the dev servers running, a user can log in,
    open "Add an inbox," pick a real provider (or "Other (IMAP/POP3)"),
    enter credentials against a real test mailbox, see it appear connected,
    and remove it.

---

## 6. Open Questions

- **OQ1.** The IMAP connector only issues `LOGIN` + `LOGOUT` — it never
  `SELECT`s a folder. Is a bare successful login enough to call the
  connection "tested," or should Feature 3 also confirm `INBOX` is
  selectable? Leaning **login-only is enough** — folder access is
  meaningfully Feature 4's concern (it needs to enumerate/select folders
  anyway to sync), and testing more here risks duplicating that work.
- **OQ2.** Connect+auth timeout is proposed at a flat **10 seconds**. Fine as
  a hardcoded constant, or should it be a config value from day one (even
  though nothing else makes it configurable yet)?
- **OQ3.** TLS validation is strict (no self-signed/expired cert
  acceptance) — some self-hosted IMAP servers use self-signed certs. Confirm
  strict-by-default is acceptable for now (a support request for "my server
  uses a self-signed cert" would need a deliberate, explicit opt-in later,
  not a silent relaxation).
- **OQ4.** `UNIQUE (user_id, address)` blocks reconnecting the exact same
  address twice under different labels (e.g. splitting one inbox into two
  differently-filtered entries — not actually possible today since there's
  no per-mailbox filtering, but worth confirming this restriction is
  intentional, not accidental).

---

## 7. Non-Goals (Out of Scope)

- **No message fetching, parsing, or syncing.** No watermarks, no `emails`
  table, no incremental sync — all Feature 4.
- **No job queue interaction.** `POST /api/mailboxes/:id/sync` (already
  declared in `api.ts`, wired to the Sidebar's "Sync now" button) stays
  **unimplemented (404)** until Feature 5 has a queue to enqueue into.
  Clicking it today fails client-side without crashing the page — a known,
  accepted rough edge until Feature 5 lands.
- **No real OAuth.** `GET /api/oauth/providers` is a hardcoded empty-list
  stub; `POST/GET /api/oauth/:id/start` doesn't exist yet — Feature 11.
- **No "mock"/demo mailbox.** Removed from the provider grid; whichever
  future feature wants a demo pipeline re-adds it deliberately.
- **No mailbox-count quota enforcement.** `TIERS[tier].maxMailboxes`
  already exists in `shared` for later use — Feature 3 enforces nothing;
  Feature 9 owns tier-limit enforcement at the edge, and can query
  `COUNT(*) FROM mailboxes WHERE user_id = $1` against it directly, no
  schema changes needed here.
- **No editing a mailbox's credentials.** Password rotation is delete +
  re-add. No `PATCH /api/mailboxes/:id`.
- **No STARTTLS / plaintext IMAP or POP3.** Implicit TLS only.
- **No rate limiting** on mailbox connection attempts (brute-force
  protection is Capability 13).
- **No audit log** of connect/disconnect events.
- **No new external stateful services or npm dependencies.**

# PRD — OAuth Provider Connectors (Gmail / Microsoft)

> Feature 13 of the project synopsis ("OAuth provider connectors (Gmail /
> Microsoft)"). This PRD delivers the **Microsoft** connector first: an
> OAuth-based connect flow for personal and work/school Microsoft accounts
> (Outlook.com / Hotmail / Office 365), speaking IMAP with XOAUTH2 so it reuses
> the existing sync engine. **Google/Gmail is deferred** within this same
> feature (Gmail already works via app-password IMAP, and Google's restricted
> mail scope requires CASA verification) — see §13; the connector abstraction is
> left open for it.

---

## 1. Problem statement

A user cannot connect a Hotmail/Outlook.com mailbox to Pigeon. Microsoft has
disabled Basic Authentication (username/password, including app passwords) for
IMAP/POP/SMTP on personal accounts, so the existing IMAP connector — which
authenticates with a stored password — fails at the auth step with
`authentication failed` (imapflow `authenticationFailed: true`, surfaced as
`{"error":"authentication failed","code":"connection_failed"}`). The only way
to read a modern Microsoft mailbox over IMAP is **OAuth2 (XOAUTH2)**. Pigeon's
OAuth surface is currently a stub (`backend/src/oauth/routes.ts` returns
`{ providers: [] }`), so Microsoft accounts are unconnectable today. This blocks
real dogfooding, since the operator's primary inboxes are Hotmail.

---

## 2. Known facts

- **Schema already anticipates OAuth.** `db/migrations/0004_mailboxes.sql`
  permits `protocol IN (... ,'gmail-oauth','microsoft-oauth')` and
  `provider IN ('gmail','outlook','icloud','fastmail','imap','mock')`.
  `password_ciphertext` is currently `NOT NULL` and holds a vault-sealed
  credential; `status` is `connected|syncing|disconnected|error`;
  `(user_id, address)` is unique.
- **OAuth route is a deliberate stub.** `backend/src/oauth/routes.ts` mounts
  only `GET /api/oauth/providers` (returns `{ providers: [] }`) behind
  `requireAuth`. `GET /api/oauth/:id/start` is intentionally a 404 until this
  feature. The frontend connect dialog already calls this endpoint and renders
  an (empty) provider list.
- **IMAP connector is provider-agnostic.** `imap.ts` +
  `imap-client.ts` wrap `imapflow` behind the injectable `ImapClient`
  interface. The production factory `defaultImapFlowFactory` builds
  `new ImapFlow({ host, port, secure, auth: { user, pass }, ... })`. `imapflow`
  natively supports XOAUTH2 via `auth: { user, accessToken }` instead of
  `pass`.
- **Credentials have exactly one unseal choke point on the sync path.**
  `backend/src/sync/engine.ts:126-138` loads the mailbox row and builds
  `TestConnectionParams` with `password: vault.open(row.password_ciphertext)`,
  then hands `params` to the connector's `listMessageIds` / `fetchMessages`.
  The connect-time HTTP verification builds the same params in
  `backend/src/mailboxes/service.ts`.
- **Connector selection is one switch.** `connectors/index.ts`
  `getConnector(protocol: "imap" | "pop3")` — its own comment says
  `gmail-oauth`/`microsoft-oauth` can be added "without touching any caller."
- **Same-origin `/api` in dev and prod.** The Astro dev server proxies `/api`
  → `http://localhost:8788` (`frontend/astro.config.mjs`); prod serves the
  static build behind Caddy which proxies `/api/*` to the backend. So a single
  redirect URI `APP_BASE_URL + /api/oauth/microsoft/callback` is same-origin in
  both environments. `APP_BASE_URL` defaults to `http://localhost:4321` in dev
  and is required in prod (`.env.example`).
- **Secrets convention.** One root `.env`, validated at startup with Zod (crash
  on malformed **required** config). Secrets are sealed AES-256-GCM by the
  `vault` module and never logged. Optional integrations degrade to a
  mock/absent path instead of crashing (coding guidelines §"Error handling").
- **Sessions, not JWTs.** `requireAuth(db)` middleware guards every resource and
  attaches `user_id`. Cookie is `httpOnly`, `SameSite=Lax`.
- **The scheduler drives first sync.** A mailbox with `last_synced_at IS NULL`
  is due on the next scheduler tick (`sync/engine.ts` first-sync path), so a
  newly connected mailbox needs no explicit initial-sync enqueue.
- **Microsoft specifics.** OAuth-based IMAP is _not_ deprecated (only Basic
  Auth was). Authority for personal + work/school accounts is the `common`
  tenant. The delegated scope for IMAP access is
  `https://outlook.office.com/IMAP.AccessAsUser.All`; `offline_access` is
  required to receive a refresh token; `openid email` identifies the connected
  address. The IMAP host is `outlook.office365.com:993` (TLS).

---

## 3. Unknowns / assumptions

- **Assumption:** The operator registers one Azure app (App registrations →
  `common` supported account types → redirect URI
  `<APP_BASE_URL>/api/oauth/microsoft/callback` → a client secret) and provides
  `MICROSOFT_CLIENT_ID` + `MICROSOFT_CLIENT_SECRET` in `.env`. There is no way
  to do real OAuth without a real app registration.
- **Assumption:** Refresh tokens issued for the `common` authority + the scopes
  above are long-lived enough for cron-cadence sync; when a refresh fails
  (revoked consent / expired token), the mailbox is marked `error` and the user
  reconnects. Microsoft does not publish a fixed refresh-token lifetime, so we
  treat refresh failure as an expected, handled runtime state, not an anomaly.
- **Assumption:** IMAP XOAUTH2 remains available for personal accounts through
  the dogfooding horizon. If Microsoft later pulls OAuth-IMAP too, a Graph-API
  connector is the fallback (out of scope here; see §7/§13).

---

## 4. Proposed solution

Add a **Microsoft OAuth inbox connector** that authenticates over IMAP with
XOAUTH2, reusing the entire existing sync/watermark/parse pipeline. The only new
concepts are (a) the OAuth authorization-code round-trip, (b) refresh-token
storage, and (c) minting a short-lived access token at credential-use time.

**4.1 Config (optional integration).** Add `MICROSOFT_CLIENT_ID` and
`MICROSOFT_CLIENT_SECRET` (secret) to the env loader/schema as **optional**.
When both are present, Microsoft OAuth is enabled; when absent, the app runs
exactly as today and the provider is simply not offered (degrade, don't crash).

**4.2 Provider discovery.** `GET /api/oauth/providers` returns
`[{ id: "microsoft", label: "Outlook / Hotmail" }]` when Microsoft OAuth is
configured, else `[]`. The frontend connect dialog renders a "Connect Outlook /
Hotmail" button for each returned provider.

**4.3 Start the flow.** `GET /api/oauth/microsoft/start` (behind
`requireAuth`):

1. generate a random `state` and a PKCE `code_verifier`/`code_challenge`;
2. insert a row into a new short-lived `oauth_states` table
   (`state` PK, `user_id`, `code_verifier`, `expires_at` ~10 min);
3. 302-redirect to Microsoft's `authorize` endpoint (`common` authority) with
   `client_id`, `redirect_uri`, `response_type=code`, `response_mode=query`,
   `scope=offline_access openid email https://outlook.office.com/IMAP.AccessAsUser.All`,
   `state`, `code_challenge`, `code_challenge_method=S256`.

**4.4 Handle the callback.** `GET /api/oauth/microsoft/callback?code&state`
(behind `requireAuth`):

1. look up + delete the `oauth_states` row; reject if missing/expired or if its
   `user_id` ≠ the session user (CSRF defense);
2. exchange `code` at Microsoft's `token` endpoint using `code_verifier` +
   `client_secret`; obtain `refresh_token` + a short-lived `access_token`;
3. resolve the mailbox address from the `id_token`/userinfo `email` claim;
4. **verify** with a real IMAP XOAUTH2 test-connect
   (`outlook.office365.com:993`, `auth:{ user: address, accessToken }`) before
   persisting — same guarantee the IMAP connect flow gives today;
5. seal the refresh token via `vault` and upsert the mailbox row
   (`provider='outlook'`, `protocol='microsoft-oauth'`, `tls=true`,
   `host='outlook.office365.com'`, `port=993`, `username=address`,
   label derived from the address, `oauth_refresh_ciphertext`, `oauth_scope`);
   on `(user_id, address)` conflict for a **different** connection, fail
   cleanly with an "already connected" message;
6. 302-redirect back to the frontend accounts page with a success (or error)
   indicator. The scheduler picks up first sync (`last_synced_at IS NULL`).

**4.5 Schema.** New migration:

- `ALTER TABLE mailboxes` — add `oauth_refresh_ciphertext TEXT`,
  `oauth_scope TEXT` (both nullable); make `password_ciphertext` nullable; add a
  CHECK enforcing "IMAP/POP3 ⇒ password present & tokens null; `*-oauth` ⇒
  refresh token present & password null."
- `CREATE TABLE oauth_states (state TEXT PRIMARY KEY, user_id UUID NOT NULL
REFERENCES users(id) ON DELETE CASCADE, code_verifier TEXT NOT NULL,
expires_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT
now())`.

**4.6 Token resolution at use time.** Add an `oauth` service function
`getAccessToken(db, vault, mailboxId): Promise<string>` that unseals the refresh
token, calls Microsoft's `token` endpoint (grant `refresh_token`), and returns a
fresh access token (rotating the stored refresh token if Microsoft returns a new
one). Access tokens are **never persisted**.

**4.7 Connector wiring.**

- Extend `TestConnectionParams` (and the `imapflow` factory) to accept an
  XOAUTH2 credential variant (`accessToken`) as an alternative to `password`;
  when present, the factory sets `auth: { user, accessToken }`.
- `getConnector` accepts `'microsoft-oauth'` and returns the IMAP connector
  (Microsoft OAuth _is_ IMAP transport; only the auth mechanism differs).
- In `sync/engine.ts`, branch at the single credential choke point: for
  `microsoft-oauth` build params from `oauth.getAccessToken(...)`; otherwise
  `vault.open(password_ciphertext)` as today. If `getAccessToken` fails
  (refresh rejected), the sync fails with a `reason` and the mailbox is marked
  `error` (existing engine behavior for connector failures).

**4.8 Reconnect.** An errored `microsoft-oauth` mailbox shows a "Reconnect"
action in the accounts UI that re-runs `.../start` for the same address; the
callback updates the token in place on the existing row rather than creating a
duplicate.

---

## 5. Pitfalls

- **Missing `offline_access` ⇒ no refresh token** ⇒ sync dies after ~1 hour.
  The scope string must include it; assert a refresh token came back at callback
  time and fail the connect if not.
- **Wrong scope shape.** IMAP access needs the full
  `https://outlook.office.com/IMAP.AccessAsUser.All` resource scope, not
  `Mail.Read` (that's a Graph scope and won't authorize IMAP). Getting this
  wrong yields a token that still fails XOAUTH2 — hence the connect-time IMAP
  test-connect in step 4.4.4 to catch it before persisting.
- **Refresh-token rotation.** Microsoft may return a _new_ refresh token on
  refresh; `getAccessToken` must persist the rotated value or the next sync
  breaks.
- **CSRF / mixing users.** The `oauth_states` row binds `state` to a `user_id`;
  the callback must verify it matches the session user and one-time-consume the
  row. Never trust `state` alone.
- **Secret leakage.** `MICROSOFT_CLIENT_SECRET`, refresh tokens, and access
  tokens must never hit logs or the DB in plaintext (vault-seal the refresh
  token; keep access tokens in memory only; exclude all from the config
  summary). Reuse the existing redaction path.
- **CHECK constraint vs. existing rows.** The nullability/CHECK migration must
  not reject the pre-existing IMAP/POP3 rows (they have a password and null
  tokens — the constraint is written to accept exactly that).
- **Test isolation.** Integration tests must fake Microsoft's authorize/token
  endpoints and the IMAP XOAUTH2 handshake behind the existing injectable
  seams (`ImapClientFactory`, an injectable token-exchange fn) — never call the
  real Microsoft endpoints. Unit tests cover PKCE/state generation and the
  scope/URL builder as pure logic.

---

## 6. Related problems solved in passing

- **Generalizes the OAuth surface for Google later.** `oauth_states`, the
  `password`/token schema split, the XOAUTH2 params variant, and the
  provider-discovery contract are provider-neutral; adding Google becomes "a new
  provider module + config keys," not a re-architecture.
- **Reconnect flow** doubles as the future "re-authorize expired mailbox" UX for
  any OAuth provider.
- **`oauth_states` cleanup** establishes the pattern for any short-lived,
  DB-backed flow state (kept EU-local, no extra stateful service).

---

## 7. Alternatives considered

- **Microsoft Graph API instead of IMAP XOAUTH2** — strategically favored by
  Microsoft and avoids IMAP entirely, but is a brand-new connector that doesn't
  fit the IMAP/POP3 `MailboxConnector` shape (different IDs, pagination, MIME),
  i.e. a second sync path to build and maintain. Rejected now: XOAUTH2 reuses
  the whole existing engine for a fraction of the work; Graph stays the fallback
  if Microsoft ever pulls OAuth-IMAP.
- **Public client (PKCE only, no secret)** — no server secret to store, but our
  backend already holds secrets safely and a confidential client yields more
  reliable refresh tokens. Rejected.
- **Persist access tokens + expiry** — saves one token call per sync, but adds
  expiry bookkeeping for negligible benefit at cron cadence. Rejected in favor
  of mint-on-use.
- **Overload `password_ciphertext` to hold the sealed refresh token** — avoids a
  migration but is semantically misleading and complicates the connector
  branch. Rejected for explicit nullable token columns + a CHECK.
- **Signed cookie for PKCE/state instead of `oauth_states`** — no migration, but
  puts the verifier in the browser and adds a signing path; a short-lived DB row
  matches Pigeon's "Postgres for everything" principle. Rejected.
- **A dedicated `reauth_required` status** — clearer than reusing `error`, but a
  bigger change (enum migration + UI branch) for the same user action
  ("Reconnect"). Deferred; reuse `error`.

---

## 8. User stories

- As a user with a Hotmail/Outlook.com account, I want to connect it by signing
  in with Microsoft (not a password), so that Pigeon can read it despite Basic
  Auth being disabled.
- As a user, I want Pigeon to keep syncing my Microsoft mailbox without
  re-entering anything, so that triage keeps working day to day.
- As a user whose consent lapsed or was revoked, I want a clear "Reconnect"
  action, so that I can restore syncing in one click.
- As the operator, I want Microsoft OAuth to be optional config, so that Pigeon
  still runs and all existing IMAP/POP3 mailboxes work when no Azure app is set
  up.

---

## 9. Functional requirements

1. **FR-1** When `MICROSOFT_CLIENT_ID` and `MICROSOFT_CLIENT_SECRET` are both
   set, `GET /api/oauth/providers` includes a `microsoft` provider; otherwise it
   returns `[]` and no Microsoft connect option is shown.
2. **FR-2** `GET /api/oauth/microsoft/start` (auth required) creates an
   `oauth_states` row (state + PKCE verifier + user + expiry) and 302-redirects
   to Microsoft's `authorize` endpoint on the `common` authority with scopes
   `offline_access openid email https://outlook.office.com/IMAP.AccessAsUser.All`
   and PKCE S256.
3. **FR-3** `GET /api/oauth/microsoft/callback` (auth required) one-time-consumes
   the `oauth_states` row, rejecting missing/expired state or a `user_id`
   mismatch with the session user.
4. **FR-4** The callback exchanges the code (PKCE verifier + client secret) for a
   refresh token + access token, and rejects the connect if no refresh token is
   returned.
5. **FR-5** The callback resolves the mailbox address from the OAuth identity
   claim and performs a real IMAP XOAUTH2 test-connect before persisting;
   a failed verification aborts without creating/altering a mailbox row.
6. **FR-6** On success the callback upserts a mailbox
   (`provider='outlook'`, `protocol='microsoft-oauth'`, `host='outlook.office365.com'`,
   `port=993`, `tls=true`, `username=address`, label derived from address,
   sealed `oauth_refresh_ciphertext`, `oauth_scope`), then redirects to the
   accounts page with a success indicator.
7. **FR-7** Connecting an address already connected by the same user returns a
   clean "already connected" outcome (no 500, no duplicate row).
8. **FR-8** The refresh token is stored vault-sealed; access tokens are never
   persisted; no token or client secret appears in logs or the config summary.
9. **FR-9** `getConnector('microsoft-oauth')` returns the IMAP connector, and the
   sync path obtains a fresh access token via `oauth.getAccessToken(...)` at
   credential-use time, rotating a returned refresh token if present.
10. **FR-10** A refresh failure during sync surfaces as a connector failure and
    marks the mailbox `status='error'` (existing engine behavior); no crash.
11. **FR-11** An errored `microsoft-oauth` mailbox offers a "Reconnect" action
    that re-runs the consent flow and updates the token on the existing row.
12. **FR-12** The schema migration adds the token columns + `oauth_states`,
    relaxes `password_ciphertext` to nullable, and enforces the
    password-XOR-token CHECK without rejecting existing IMAP/POP3 rows.
13. **FR-13** Expired `oauth_states` rows are not usable and are cleaned up
    (on-consume delete plus expiry filtering; no unbounded growth).

---

## 10. Technical requirements

(Only what the coding guidelines don't already cover.)

- **New module `backend/src/oauth/`** owns provider discovery, the
  start/callback routes, PKCE/state helpers, the Microsoft token-exchange
  client (behind an injectable function so tests never hit the network), and
  `getAccessToken`. The Microsoft IMAP endpoint constants live here.
- **Connector params** gain an XOAUTH2 credential variant; the `imapflow`
  factory selects `auth:{ user, accessToken }` vs `auth:{ user, pass }`. Keep
  the `ImapClient` fake interface unchanged (tests inject the token).
- **Env schema:** `MICROSOFT_CLIENT_ID` (optional, string) and
  `MICROSOFT_CLIENT_SECRET` (optional, secret, redacted). Document both in
  `.env.example`, including the exact Azure redirect URI to register.
- **Testing:** unit tests for PKCE/state/scope-URL building and the
  params→auth mapping; integration tests (embedded Postgres) for the migration
  - CHECK, the callback happy path, state/CSRF rejection, duplicate-address, and
    the `microsoft-oauth` sync path — all with Microsoft's endpoints and the IMAP
    XOAUTH2 handshake faked behind their seams. No live Microsoft calls, ever.

---

## 11. Acceptance criteria

- With a valid Azure app configured, a user can click "Connect Outlook /
  Hotmail," consent at Microsoft, land back on the accounts page with the
  mailbox connected, and see it sync on the next scheduler tick.
- With no Microsoft config, `pnpm dev`/prod boot unchanged, all existing
  IMAP/POP3 mailboxes work, and no Microsoft option is shown.
- A tampered/expired/foreign `state` at the callback is rejected and no mailbox
  is created.
- A connected Microsoft mailbox continues syncing across access-token expiry
  (refresh path exercised) without user action.
- Revoking consent flips the mailbox to `error`; "Reconnect" restores syncing.
- No plaintext token or client secret appears in logs, the DB, or the config
  summary.
- `pnpm validate` is green (lint, typecheck, unit + integration, frontend
  build).

---

## 12. Open questions

- **OQ-A** Redirect target after callback: a dedicated
  `/accounts?connected=outlook` (success/error query flag the SolidJS island
  reads) vs. a generic accounts redirect. Leaning to the query-flag approach for
  a clear toast; confirm the exact param names during task breakdown.
- **OQ-B** `oauth_states` cleanup: rely solely on on-consume delete + expiry
  filtering, or add a tiny periodic sweep? Given low volume, on-consume +
  expiry filter is likely enough; revisit only if orphaned rows accumulate
  (abandoned consents).

---

## 13. Non-goals (out of scope)

- **Google / Gmail OAuth.** Deferred — Gmail already works via app-password
  IMAP, and Google's `https://mail.google.com/` restricted scope requires
  CASA verification (weeks + annual paid audit). The abstraction is left open
  for it.
- **Microsoft Graph API transport.** IMAP XOAUTH2 only; Graph is the documented
  fallback if OAuth-IMAP is ever withdrawn.
- **SMTP / sending mail** via the Microsoft token (Pigeon is read/triage only,
  one-way today).
- **A `reauth_required` status value** and any richer OAuth mailbox health model
  beyond reusing `error`.
- **iCloud / Fastmail / other providers'** OAuth.
- **Admin/multi-tenant Azure consent** (admin-consent, app roles); this is
  per-user delegated consent only.

# Relevant Files

- `backend/src/config/index.ts` - Add `MICROSOFT_CLIENT_ID` / `MICROSOFT_CLIENT_SECRET` (optional, secret redacted) to the Zod schema + `Config` type + `describeConfig`.
- `backend/src/config/test/config.test.ts` - Unit tests for the new config keys and redaction.
- `db/migrations/0015_oauth_connectors.sql` - Token columns on `mailboxes`, nullable `password_ciphertext`, password-XOR-token CHECK, new `oauth_states` table.
- `backend/src/oauth/microsoft.ts` - Microsoft constants (authority, IMAP host/port, scopes), authorize-URL builder, and the injectable token-exchange client.
- `backend/src/oauth/test/microsoft.test.ts` - Unit tests for the authorize-URL builder and token-exchange request shaping.
- `backend/src/oauth/pkce.ts` - PKCE `code_verifier`/`code_challenge` (S256) + random `state` generation.
- `backend/src/oauth/test/pkce.test.ts` - Unit tests for PKCE/state generation.
- `backend/src/oauth/states.ts` - `oauth_states` repository: insert, one-time consume, expiry filtering.
- `backend/src/oauth/test/states.integration.test.ts` - Integration tests (SQL contract) for the states repo.
- `backend/src/oauth/tokens.ts` - `getAccessToken(db, vault, mailboxId)`: unseal refresh token, run the refresh grant, rotate a returned refresh token, return a fresh access token.
- `backend/src/oauth/test/tokens.integration.test.ts` - Integration tests for the DB-backed refresh/rotation.
- `backend/src/oauth/routes.ts` - Replace the stub: provider discovery + `microsoft/start` + `microsoft/callback`.
- `backend/src/oauth/test/routes.integration.test.ts` - Integration tests for discovery, start, and callback (happy + error paths).
- `backend/src/mailboxes/connectors/types.ts` - Extend `TestConnectionParams` with an XOAUTH2 access-token credential variant.
- `backend/src/mailboxes/connectors/imap-client.ts` - Factory selects `auth:{ user, accessToken }` vs `auth:{ user, pass }`.
- `backend/src/mailboxes/connectors/index.ts` - `getConnector` accepts `'microsoft-oauth'` → IMAP connector.
- `backend/src/mailboxes/connectors/test/connectors.test.ts` - Unit tests for the params→auth mapping and connector lookup.
- `backend/src/sync/engine.ts` - Branch the single credential choke point: `microsoft-oauth` builds params from `getAccessToken`, else `vault.open`.
- `backend/src/queue/handlers/sync-mailbox.ts` - Widen protocol handling to route `microsoft-oauth` mailboxes.
- `backend/src/sync/test/engine.integration.test.ts` - Integration test for the `microsoft-oauth` sync path + refresh-failure → `error` status.
- `frontend/src/components/AddInboxDialog.tsx` - Render a "Connect Outlook / Hotmail" button from `/api/oauth/providers`.
- `frontend/src/components/Sidebar.tsx` / accounts view - "Reconnect" action on an errored `microsoft-oauth` mailbox.
- `frontend/src/lib/providers.ts`, `frontend/src/lib/api.ts` - Provider metadata + client calls for the OAuth start/reconnect.
- `.env.example` - Document `MICROSOFT_CLIENT_ID` / `MICROSOFT_CLIENT_SECRET` and the exact Azure redirect URI.
- `docs/LOCAL_SETUP.md` - Operator steps to register the Azure app.

# Tasks

- [x] 1.0 Config: optional Microsoft OAuth credentials
  - [x] 1.1 RED (unit): With the write-test agent, add a `config.test.ts` case asserting `parseConfig` accepts `MICROSOFT_CLIENT_ID` + `MICROSOFT_CLIENT_SECRET` and exposes them on `Config`, and that both default to `undefined` when absent. (Actual path: `backend/test/config.test.ts`.)
  - [x] 1.2 CONFIRM RED: `pnpm exec vitest run --project unit backend/test/config.test.ts -t "Microsoft OAuth credentials"` — failed (value came back `undefined`).
  - [x] 1.3 GREEN: With the write-code agent, add both keys to the Zod schema (optional strings), the `Config` type, and the `parseConfig` mapping in `backend/src/config/index.ts`.
  - [x] 1.4 CONFIRM GREEN: Re-run the same test file — passes.
  - [x] 1.5 RED (unit): With the write-test agent, assert `describeConfig` reports only presence (boolean) for `MICROSOFT_CLIENT_SECRET`, never its value.
  - [x] 1.6 CONFIRM RED / GREEN: Run the test (fails), implement redaction in `describeConfig` with the write-code agent, re-run (passes).
  - [x] 1.7 CHECK PHASE: `pnpm check` (static + unit) — green, 149 unit tests pass. (Also updated 4 `Config` fixtures in llm/mail tests for the new required fields.)

- [x] 2.0 Schema migration (token columns, CHECK, `oauth_states`)

  > Integration tests required: this is a SQL/migration/constraint contract against real Postgres. Use the documented `withTestDb()` fixture (`backend/test/db.ts`); never hand-roll a cluster.
  - [x] 2.1 GREEN: With the write-code agent, create `db/migrations/0015_oauth_connectors.sql`: nullable `oauth_refresh_ciphertext`/`oauth_scope`, drop NOT NULL on `password_ciphertext`, named CHECK `mailboxes_credential_by_protocol_check` (password-XOR-oauth-token by protocol), and `oauth_states` table.
  - [x] 2.2 RED (integration): With the write-test agent, add `backend/src/oauth/test/states.integration.test.ts` (imap row inserts; microsoft-oauth-with-password rejected by CHECK; well-formed microsoft-oauth row inserts). Note: migration written first (per task order) so genuine RED not observable; test confirms the CHECK contract directly.
  - [x] 2.3 / 2.4 CONFIRM: Ran only that file — 3/3 pass (imap ok, microsoft-oauth-with-password rejected, well-formed microsoft-oauth ok).
  - [x] 2.5 CHECK PHASE: `pnpm check` — green, 149 unit tests pass.

- [x] 3.0 PKCE + state generation
  - [x] 3.1 RED (unit): `pkce.test.ts` asserting `generateCodeVerifier` is high-entropy URL-safe (43–128), `computeCodeChallenge` is base64url SHA-256 (S256) of the verifier, and `generateState` is unique random.
  - [x] 3.2 CONFIRM RED: Ran only `backend/src/oauth/test/pkce.test.ts` — failed (module `../pkce` absent).
  - [x] 3.3 GREEN: Implemented `backend/src/oauth/pkce.ts` using `node:crypto`.
  - [x] 3.4 CONFIRM GREEN: Re-ran that file — 7/7 pass.
  - [x] 3.5 CHECK PHASE: `pnpm check` — green, 156 unit tests pass.

- [x] 4.0 Microsoft authorize-URL builder + token-exchange request shaping (pure)
  - [x] 4.1 RED (unit): `microsoft.test.ts` asserting the authorize URL targets the `common` authority, `response_type=code`, `response_mode=query`, `code_challenge_method=S256`, the exact scope string, and the passed `client_id`/`redirect_uri`/`state`/`code_challenge`.
  - [x] 4.2 CONFIRM RED: Ran only that file — failed (module `../microsoft` absent).
  - [x] 4.3 GREEN: Implemented URL builder + endpoint/scope/IMAP-host constants in `backend/src/oauth/microsoft.ts`.
  - [x] 4.4 RED (unit): Asserted `exchangeCode` (authorization_code grant w/ `code_verifier`+`client_secret`) and `refreshAccessToken` (refresh_token grant) post the expected form to `MICROSOFT_TOKEN_ENDPOINT` via an injected `TokenPoster`, and map snake_case→camelCase.
  - [x] 4.5 CONFIRM RED / GREEN: Ran (4 failed — fns unexported), implemented `exchangeCode`/`refreshAccessToken`/`TokenPoster`/`TokenResult`, re-ran — 5/5 pass.
  - [x] 4.6 CHECK PHASE: `pnpm check` — green, 161 unit tests. (Fixed `no-explicit-any` in `microsoft.ts` → `unknown`+typed body, and a `mock.calls[0]` strict-undefined typing in the test.)

- [x] 5.0 Connector XOAUTH2 credential wiring
  - [x] 5.1 RED (unit): New `backend/src/mailboxes/test/imap-client.test.ts` (mocks `imapflow`) asserting `defaultImapFlowFactory` builds `auth:{ user, accessToken }` for access-token params and `auth:{ user, pass }` for password params. (Existing `connectors.test.ts` is POP3-only, so IMAP factory got its own file.)
  - [x] 5.2 CONFIRM RED: Ran it — password test passes, access-token test fails (`{user, pass: undefined}` vs `{user, accessToken}`).
  - [x] 5.3 GREEN: `TestConnectionParams` → discriminated union (`PasswordConnectionParams | AccessTokenConnectionParams`, mutually exclusive) in `types.ts`; branched `defaultImapFlowFactory` on `params.accessToken` in `imap-client.ts`.
  - [x] 5.4 RED (unit): In `connectors.test.ts`, asserted `getConnector('microsoft-oauth') === imapConnector`.
  - [x] 5.5 CONFIRM RED / GREEN: Ran (threw `unsupported protocol`), widened `getConnector` union + added `microsoft-oauth` case → `imapConnector`, re-ran — passes.
  - [x] 5.6 CHECK PHASE: `pnpm check` — green, 164 unit tests pass.

- [x] 6.0 `oauth_states` repository

  > Integration tests required: SQL contract (insert / one-time consume / expiry) against real Postgres via `withTestDb()`.
  - [x] 6.1 RED (integration): Extended `states.integration.test.ts` — insert-then-consume returns `{userId, codeVerifier}` and deletes (second consume null), expired consume null, distinguishes two users' states.
  - [x] 6.2 CONFIRM RED: Ran — failed (`Cannot find module '../states'`).
  - [x] 6.3 GREEN: Implemented `backend/src/oauth/states.ts` — `insertOAuthState` + `consumeOAuthState` (atomic `DELETE ... WHERE state=$ AND expires_at > now() RETURNING`), parameterized tagged-template SQL.
  - [x] 6.4 CONFIRM GREEN: Re-ran the file — 6/6 pass (3 migration + 3 repo).
  - [x] 6.5 CHECK PHASE: `pnpm check` — green, 164 unit tests. (Fixed a strict `rows[0]` possibly-undefined via local guard.)

- [x] 7.0 DB-backed access-token resolution (`getAccessToken`) with rotation

  > Integration tests required: reads the sealed refresh token from a real `mailboxes` row and persists a rotated token. Use `withTestDb()`; the token-exchange HTTP call is injected/faked.
  - [x] 7.1 RED (integration): `tokens.integration.test.ts` asserting `getAccessToken(db, vault, mailboxId, refresh)` unseals the stored refresh token, calls the faked refresh grant, returns the fresh access token.
  - [x] 7.2 CONFIRM RED: Ran — failed (`Cannot find module '../tokens'`).
  - [x] 7.3 GREEN: Implemented `backend/src/oauth/tokens.ts` (happy path: unseal via `vault.open`, call injected `refresh`, return `accessToken`).
  - [x] 7.4 RED (integration): Asserted a rotated refresh token (`rt-rotated` ≠ stored) is re-sealed + persisted in place.
  - [x] 7.5 CONFIRM RED / GREEN: Ran (`rt-original` vs `rt-rotated` mismatch), added rotation `UPDATE`, re-ran — passes.
  - [x] 7.6 RED (integration): Two guards — a rejecting `refresh` propagates (pin, GREEN on first run) AND a grant resolving an empty `accessToken` must reject (RED).
  - [x] 7.7 CONFIRM RED / GREEN: Ran (empty-token case failed), added empty-access-token guard before rotation UPDATE, re-ran — 4/4 pass.
  - [x] 7.8 CHECK PHASE: `pnpm check` — green, 164 unit tests.

- [x] 8.0 Provider discovery route

  > Integration test required: the route sits behind `requireAuth(db)` (real session lookup). Use `withTestDb()`.
  - [x] 8.1 RED (integration): Updated `routes.integration.test.ts` — `GET /api/oauth/providers` returns `[{ id:"microsoft", label:"Outlook / Hotmail", startPath:"/api/oauth/microsoft/start" }]` when both keys set, `[]` when absent (and `[]` when only one key present).
  - [x] 8.2 CONFIRM RED: Ran — `{ providers: [] }` vs expected 1-provider list.
  - [x] 8.3 GREEN: `oauthRoutes(db, config)` now builds the list from `MICROSOFT_CLIENT_ID`+`MICROSOFT_CLIENT_SECRET` presence; threaded optional `config` (default `{}`) through `createApp` + `server.ts` bootstrap (no churn to the ~20 existing `createApp` test callers).
  - [x] 8.4 CONFIRM GREEN: Re-ran — 3/3 pass.
  - [x] 8.5 CHECK PHASE: `pnpm check` — green, 164 unit tests.

- [ ] 9.0 `GET /api/oauth/microsoft/start`

  > Integration test required: creates an `oauth_states` row behind `requireAuth`. Use `withTestDb()`.
  - [x] 9.1 RED (integration): With the write-test agent, assert `start` (authed) inserts one `oauth_states` row for the session user and 302-redirects to a Location whose host/scopes/PKCE match the builder from 4.0.
  - [x] 9.2 CONFIRM RED: Ran only the routes integration file — 3/3 start tests fail (no `/microsoft/start` route → 404; unauthenticated returns 404 not 401; no redirect Location).
  - [x] 9.3 GREEN: With the write-code agent, implemented the `start` handler wiring PKCE (3.0), the states repo (6.0), and the URL builder (4.0); added `APP_BASE_URL` to `OAuthRoutesConfig`.
  - [x] 9.4 CONFIRM GREEN: Re-ran only that file — 3/3 start tests pass.
  - [x] 9.5 CHECK PHASE: `pnpm check:static && pnpm test:unit` — green.

- [ ] 10.0 `GET /api/oauth/microsoft/callback` — happy path

  > Integration test required: consumes state, upserts a mailbox, and runs a verification connect (IMAP factory + token exchange injected/faked). Use `withTestDb()`.
  - [x] 10.1 RED (integration): With the write-test agent, assert that with a valid state + faked code exchange (returns refresh + access token + `email` claim) and a faked successful IMAP XOAUTH2 verify, the callback creates a `mailboxes` row (`provider='outlook'`, `protocol='microsoft-oauth'`, host/port/tls set, sealed `oauth_refresh_ciphertext`, `oauth_scope`, label from address) and 302-redirects to the accounts page with a success flag. Design: `oauthRoutes(db, config, deps?)` with `deps={vault, post?, connector?}`; address resolved from `id_token` email claim; success redirect `${APP_BASE_URL}/?connected=outlook`.
  - [x] 10.2 CONFIRM RED: Ran only the callback test — fails (404 vs 302, no route).
  - [x] 10.3 GREEN: With the write-code agent, implemented the callback: consume state, exchange code, resolve address (added `parseIdTokenEmail` + `idToken` to `microsoft.ts`), verify via injected IMAP connector, seal + insert, enqueue sync, redirect. Wired `createApp` to pass `{ vault }` + `APP_BASE_URL` into `oauthRoutes`.
  - [x] 10.4 CONFIRM GREEN: Re-ran only the callback test — passes.
  - [x] 10.5 CHECK PHASE: `pnpm check:static && pnpm test:unit` — green (164 unit).

- [x] 11.0 Callback error & CSRF paths
  - [x] 11.1 RED (integration): Added a test asserting missing/expired `state` is rejected without creating a mailbox.
  - [x] 11.2 CONFIRM RED / GREEN: Pinned GREEN on first run — the `consumeOAuthState` expiry `WHERE expires_at > now()` + callback null-guard already reject it (302 `?connected=error`, no mailbox row).
  - [x] 11.3 RED (integration): Added a test asserting a `state` whose `user_id` ≠ the session user is rejected (CSRF).
  - [x] 11.4 CONFIRM RED / GREEN: Pinned GREEN — existing `consumed.userId !== session user` guard rejects it.
  - [x] 11.5 RED (integration): Added a test asserting a code exchange returning no refresh token aborts (no mailbox row).
  - [x] 11.6 CONFIRM RED / GREEN: Pinned GREEN — existing missing-refresh-token guard redirects to `?connected=error`.
  - [x] 11.7 RED (integration): Added a test asserting connecting an address already connected by the same user returns a clean "already connected" outcome (no 500, no duplicate row).
  - [x] 11.8 CONFIRM RED / GREEN: Ran (RED — unhandled 23505 → 500); with the write-code agent wrapped the INSERT in a try/catch that maps a unique violation to a 302 `?connected=already`; re-ran — passes.
  - [x] 11.9 RED (integration): Added a test asserting a failed IMAP XOAUTH2 verify aborts without persisting a mailbox.
  - [x] 11.10 CONFIRM RED / GREEN: Pinned GREEN — existing `!verify.ok` guard redirects to `?connected=error`.
  - [x] 11.11 CHECK PHASE: `pnpm check:static && pnpm test:unit` — green (164 unit).

- [x] 12.0 Reconnect an errored OAuth mailbox
  - [x] 12.1 RED (integration): With the write-test agent, added a test asserting re-running the flow for an address already present as a `microsoft-oauth` mailbox in `status='error'` updates the sealed refresh token in place (same row id) and resets status, rather than creating a duplicate.
  - [x] 12.2 CONFIRM RED: Ran only that test — fails (`?connected=already` vs `?connected=outlook`; the 23505 path never updates the errored row).
  - [x] 12.3 GREEN: With the write-code agent, on a 23505 the callback now attempts an in-place UPDATE scoped to `status='error'` microsoft-oauth rows for the same user/address (rotate sealed token + scope, reset status to `syncing`, enqueue sync, redirect `?connected=outlook`); non-errored duplicates still redirect `?connected=already`.
  - [x] 12.4 CONFIRM GREEN: Re-ran the reconnect test (passes) + the task-11 "already connected" test (no regression).
  - [x] 12.5 CHECK PHASE: `pnpm check:static && pnpm test:unit` — green (164 unit).

- [x] 13.0 Sync path for `microsoft-oauth`

  > Integration test required: exercises `syncMailbox` end-to-end against real Postgres with the token exchange + IMAP handshake faked. Use `withTestDb()`.
  - [x] 13.1 RED (integration): Added a test to `engine.integration.test.ts` asserting a `microsoft-oauth` mailbox resolves creds via an injected `resolveAccessToken` (faked) and passes an access-token params variant (no `vault.open` of a password) to the connector. Design: trailing optional 6th param `resolveAccessToken?: (mailboxId) => Promise<string>` on `syncMailbox`.
  - [x] 13.2 CONFIRM RED: Ran only that test — fails (`vault.open(null)` throws on the NULL `password_ciphertext`).
  - [x] 13.3 GREEN: With the write-code agent, branched the credential choke point in `engine.ts` on `protocol` (oauth → injected `resolveAccessToken`, no `vault.open`), widened `sync-mailbox.ts` + `worker-loop.ts` to route `microsoft-oauth`, and wired the production resolver in `worker.ts` (`getAccessToken` + `refreshAccessToken` + fetch `TokenPoster` from config). All 12 engine tests pass.
  - [x] 13.4 RED (integration): Added a test asserting a rejecting `resolveAccessToken` (revoked refresh) makes the sync return `{ok:false, reason}`, marks `status='error'`, ingests nothing, and never calls the connector.
  - [x] 13.5 CONFIRM RED / GREEN: Ran (RED — rejection propagated out of `syncMailbox`); with the write-code agent wrapped the resolver call in try/catch → `markError` + `{ok:false, reason}`; re-ran — 13/13 engine tests pass.
  - [x] 13.6 CHECK PHASE: `pnpm check:static && pnpm test:unit` — green (164 unit).

- [x] 14.0 Frontend connect + reconnect UI

  > Per coding guidelines, frontend components aren't unit-tested; the Astro build is the gate. Verify behavior in the browser.
  - [x] 14.1 GREEN: With the write-code agent, wired the Step-1 OAuth section in `AddInboxDialog.tsx` (already rendered only when `/api/oauth/providers` returns `microsoft`) to the real backend shape — button now reads "Connect Outlook / Hotmail" and links to `oauth.startUrl("microsoft")` (`/api/oauth/microsoft/start`). Fixed the frontend/backend contract mismatch: `OAuthProviderInfo` in `frontend/src/lib/api.ts` changed from `{id, displayName, providerBadge}` to the backend's `{id, label, startPath}`. (`outlook` provider metadata already present in `providers.ts`.)
  - [x] 14.2 GREEN: With the write-code agent, in `Sidebar.tsx` an errored `microsoft-oauth` mailbox now redirects to `oauth.startUrl("microsoft")` on click (OAuth reconnect) instead of opening the password dialog; password mailboxes still use `openReconnect`.
  - [x] 14.3 CONFIRM: `pnpm build` (frontend) — succeeds (10 pages built). NOTE: manual browser verification NOT performed — it requires a configured Azure app + live Microsoft consent round-trip, which is unavailable in this environment. Code + typecheck + build are green; the consent/redirect happy path is covered by the backend integration tests (start + callback).
  - [x] 14.4 CHECK PHASE: `pnpm check:static && pnpm test:unit` — green (164 unit).

- [x] 15.0 Operator setup docs + `.env.example` (manual Azure step)
  - [x] 15.1 GREEN: Documented `MICROSOFT_CLIENT_ID` + `MICROSOFT_CLIENT_SECRET` (secret) in `.env.example`, including the exact redirect URI `<APP_BASE_URL>/api/oauth/microsoft/callback`.
  - [x] 15.2 GREEN: Added a "Microsoft OAuth (Outlook / Hotmail)" section to `docs/LOCAL_SETUP.md` with step-by-step Azure app registration (App registrations → New → account types = any org + personal MS accounts / `common` → Web redirect URI → Certificates & secrets → new client secret → copy client ID + secret into `.env`).
  - [x] 15.3 CHECK PHASE: `pnpm check:static && pnpm test:unit` — green (164 unit).

- [x] 16.0 Final: `pnpm validate` equivalent — static checks ✓, unit 164/164 ✓, frontend build ✓ (10 pages), and the full integration project 45/45 files (291 tests) ✓. NOTE: the integration project was run in 5 batches rather than one `pnpm validate` invocation because the whole suite exceeds the tool's ~25-min execution ceiling on this Windows host (a fresh embedded Postgres cluster is booted per file). Fixed one pre-existing regression: `migrate.integration.test.ts` + `migrate-cli.integration.test.ts` hard-coded the migration count at 13 (already stale after `0014_account_management`); updated to 15 and added the `0014`/`0015` inventory rows.

- [ ] Commit message: `feat(oauth): connect Microsoft (Outlook/Hotmail) mailboxes via OAuth IMAP XOAUTH2`

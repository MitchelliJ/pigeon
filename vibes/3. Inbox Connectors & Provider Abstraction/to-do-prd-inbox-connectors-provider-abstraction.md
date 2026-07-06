# Relevant Files

- `db/migrations/0004_mailboxes.sql` - New migration: `mailboxes` table (PRD §3.2.1).
- `backend/test/migrate.test.ts` - Existing generic migration-runner test; must be updated to expect 4 applied migrations (was hardcoded to 3) including `0004_mailboxes.sql`.
- `backend/test/mailboxes-schema.test.ts` - New schema-shape test for migration 0004 (mirrors `backend/test/auth-schema.test.ts`'s pattern for 0003).
- `backend/src/vault/index.ts` - New `vault` module: `createVault(masterKeyBase64)` → `{ seal, open }`, AES-256-GCM (PRD FR-1..FR-3).
- `backend/src/vault/test/vault.test.ts` - Round-trip, tamper-detection, wrong-key, and malformed-key tests.
- `backend/src/config/index.ts` - Add `VAULT_MASTER_KEY` (required, base64/32-byte) and `MAILBOX_CONNECT_TIMEOUT_MS` (optional, default 10000) to the Zod schema, `Config` type, `parseConfig`, `describeConfig` (PRD §3.4).
- `backend/test/config.test.ts` - Existing config tests updated (empty-env and production-success fixtures need a valid `VAULT_MASTER_KEY` added) + new tests for the two new keys.
- `.env.example` - Document `VAULT_MASTER_KEY` and `MAILBOX_CONNECT_TIMEOUT_MS` (PRD FR-16, FR-17).
- `backend/src/mailboxes/connectors/types.ts` - `MailboxConnector` interface (PRD FR-4).
- `backend/src/mailboxes/connectors/imap.ts` - Hand-rolled minimal IMAP `testConnection` (TLS + `LOGIN`/`LOGOUT`) (PRD FR-5).
- `backend/src/mailboxes/connectors/pop3.ts` - Hand-rolled minimal POP3 `testConnection` (TLS + `USER`/`PASS`/`QUIT`) (PRD FR-5).
- `backend/src/mailboxes/connectors/index.ts` - `getConnector(protocol)` lookup (PRD FR-5, forward-compatible with Feature 11).
- `backend/src/mailboxes/test/fixtures/test-cert.pem` / `test-key.pem` - Committed self-signed test certificate used only by the fake IMAP/POP3 test servers.
- `backend/src/mailboxes/test/fixtures.ts` - Fake in-process TLS IMAP/POP3 test servers used by connector tests (accept a correct login, reject a wrong one, and a "never responds" variant for timeout tests).
- `backend/src/mailboxes/test/connectors.test.ts` - Integration tests against the fake servers (success, wrong password, connection refused, timeout, cert-validation-failure logging).
- `backend/src/mailboxes/service.ts` - Business logic: duplicate check, connector invocation, vault seal, insert/delete (PRD FR-6..FR-9).
- `backend/src/mailboxes/routes.ts` - `mailboxesRoutes(db, vault)`: `POST /api/mailboxes`, `DELETE /api/mailboxes/:id`, both behind `requireAuth` (PRD §3.2.3, §3.2.4).
- `backend/src/mailboxes/test/routes.test.ts` - Integration tests (embedded Postgres, injected fake connector) covering AC-1..AC-6, AC-9.
- `backend/src/mailboxes/dashboard.ts` - `dashboardRoutes(db)`: `GET /api/dashboard`, real `user`+`accounts`, placeholder `stats`/`emails`/`channels`/`digest`/`lastSync` (PRD §3.2.5).
- `backend/src/mailboxes/test/dashboard.test.ts` - Integration tests for the aggregator (AC-7).
- `backend/src/oauth/routes.ts` - `oauthRoutes()`: `GET /api/oauth/providers` stub → `200 { providers: [] }` (PRD §3.2.6).
- `backend/src/oauth/test/routes.test.ts` - Test for the stub (AC-8).
- `backend/src/server.ts` - Mount `authRoutes` (pre-existing gap from Feature 2), `mailboxesRoutes`, `dashboardRoutes`, `oauthRoutes`; `createApp` gains the `vault`/`mail` dependencies it needs to build them.
- `frontend/src/lib/providers.ts` - Remove the `"mock"` entry from `PROVIDERS` (PRD FR-12).
- `frontend/src/components/AddInboxDialog.tsx` - Remove the `provider() !== "mock"` special-casing (PRD FR-12).

---

# Tasks

- [ ] 1.0 Database: `mailboxes` table migration
  - [x] 1.1 RED: Write failing tests with the write-test agent:
    - `backend/test/mailboxes-schema.test.ts` (new, mirrors `auth-schema.test.ts`): after `runMigrations`, assert `to_regclass('public.mailboxes')` is not null, assert each column exists with the right type/nullability via `information_schema.columns`, and assert the `(user_id, address)` unique constraint and the `status`/`provider`/`protocol` CHECK constraints exist (query `information_schema.table_constraints`/`pg_constraint`).
    - Update `backend/test/migrate.test.ts`'s `"applies the initial migrations..."` test: change `expect(rows.length).toBe(3)` to `toBe(4)` and add the `id: 4, filename: "0004_mailboxes.sql"` assertion. Also update the idempotency test's expected count from 3 to 4.
  - [x] 1.2 CONFIRM RED: Run `pnpm --filter @pigeon/backend test mailboxes-schema migrate` with the bash tool — verify both files fail (missing table / wrong row count). **Confirmed:** 7/11 tests failed as expected (`to_regclass` null, `relation "mailboxes" does not exist`, row counts 3≠4); the 2 pre-existing unrelated tests (health table, out-of-order guard) still pass.
  - [x] 1.3 GREEN: Implement `db/migrations/0004_mailboxes.sql` with the write-code agent per PRD §3.2.1 (all columns, the three CHECK constraints, the `(user_id, address)` unique constraint, the `(user_id)` index).
  - [x] 1.4 CONFIRM GREEN: Run the same test command — verify all pass. **Confirmed:** 11/11 tests passed across both files.
  - [x] 1.5 REFACTOR: Migration file already clean on first pass (reviewed inline, matches 0003's style); no refactor needed. CONFIRM GREEN already covered by 1.4.
  - [x] 1.6 CHECK PHASE: Run `pnpm check` with the bash tool. **Confirmed:** lint clean, all 3 workspaces typecheck clean (shared/backend/frontend).

- [ ] 2.0 Vault module (`backend/src/vault/`)
  - [x] 2.1 RED: Write-test agent writes `backend/src/vault/test/vault.test.ts`: `createVault(key).seal(plaintext)` then `.open(sealed)` returns the original plaintext; sealing the same plaintext twice yields different ciphertext (random IV) but both open correctly; flipping a character in the sealed string's ciphertext or auth-tag segment makes `.open()` throw; opening with a `createVault` built from a _different_ valid 32-byte key throws; a key that isn't valid base64, or doesn't decode to exactly 32 bytes, makes `createVault` throw immediately (not lazily on first seal/open).
  - [x] 2.2 CONFIRM RED: Run `pnpm --filter @pigeon/backend test vault` with the bash tool — verify it fails (module doesn't exist). **Confirmed:** module resolution error, "Cannot find module '../index'".
  - [x] 2.3 GREEN: Write-code agent implements `backend/src/vault/index.ts`: `createVault(masterKeyBase64: string): { seal(plaintext: string): string; open(sealed: string): string }` using `node:crypto` `createCipheriv`/`createDecipheriv` with `aes-256-gcm`, a random 12-byte IV per `seal`, format `gcm:ivBase64:authTagBase64:ciphertextBase64`.
  - [x] 2.4 CONFIRM GREEN: Run the same test command — verify all pass. **Confirmed:** 8/8 tests passed.
  - [x] 2.5 REFACTOR: Implementation already clean (parse/serialize already factored into a small `decodeMasterKey` helper); no refactor needed.
  - [x] 2.6 CHECK PHASE: Run `pnpm check` with the bash tool. **Confirmed:** lint clean, all 3 workspaces typecheck clean.

- [ ] 3.0 Config: `VAULT_MASTER_KEY` + `MAILBOX_CONNECT_TIMEOUT_MS`
  - [x] 3.1 RED: Write-test agent updates `backend/test/config.test.ts`:
    - Add a valid `VAULT_MASTER_KEY` (a fixed, committed test-only base64 32-byte value) to the existing `"returns documented defaults when env is empty"` and `"succeeds in production..."` fixtures (they will otherwise start failing once the key is required) — add assertions there too: `cfg.VAULT_MASTER_KEY` equals what was passed, `cfg.MAILBOX_CONNECT_TIMEOUT_MS` defaults to `10000`.
    - New test: `parseConfig({})` (no `VAULT_MASTER_KEY` at all) throws a ZodError mentioning `VAULT_MASTER_KEY`, in `development` (default `NODE_ENV`) — i.e. required in _every_ environment, not just production.
    - New test: a `VAULT_MASTER_KEY` that isn't valid base64, or that decodes to something other than 32 bytes, throws mentioning `VAULT_MASTER_KEY`.
    - New test: `MAILBOX_CONNECT_TIMEOUT_MS: "5000"` parses to the number `5000`; a non-numeric value throws mentioning `MAILBOX_CONNECT_TIMEOUT_MS`.
  - [x] 3.2 CONFIRM RED: Run `pnpm --filter @pigeon/backend test config` with the bash tool — verify the new/updated cases fail as expected (existing passing tests will now fail too since the fixtures don't yet include the key — confirm that's the failure mode). **Confirmed:** 7/20 failed exactly as expected (undefined VAULT_MASTER_KEY/MAILBOX_CONNECT_TIMEOUT_MS, missing throws); 13 unrelated tests still pass.
  - [x] 3.3 GREEN: Write-code agent extends `backend/src/config/index.ts`: `VAULT_MASTER_KEY: z.string()` with a `.superRefine` check for valid base64 decoding to exactly 32 bytes, required in every `NODE_ENV` (not gated behind the existing `requireInProd` helper — add a top-level required check); `MAILBOX_CONNECT_TIMEOUT_MS: z.coerce.number().int().positive().default(10000)`. Update the `Config` type and `describeConfig` (report `VAULT_MASTER_KEY` as `"set"/"not set"` only, never the value; `MAILBOX_CONNECT_TIMEOUT_MS` can be echoed since it isn't a secret). Also update `.env.example` with both keys (commented), reusing the `.env.old` generation snippet for `VAULT_MASTER_KEY`. Exported `vault`'s `decodeMasterKey` helper so `config` reuses the single 32-byte/base64 validation rule instead of duplicating it.
  - [x] 3.4 CONFIRM GREEN: Run the same test command — verify all pass. **Confirmed:** 28/28 passed (20 config + 8 vault).
  - [x] 3.5 REFACTOR: Implementation already clean; no refactor needed.
  - [x] 3.6 CHECK PHASE: Run `pnpm check` with the bash tool. **Found + fixed a regression:** `backend/src/mail/test/mock.test.ts` and `resend.test.ts` build literal `Config` objects that didn't have the two new required fields — typecheck failed with TS2739 on both. Fixed by adding `VAULT_MASTER_KEY`/`MAILBOX_CONNECT_TIMEOUT_MS` to both literals (same fixed test key used in `config.test.ts`), purely additive. Re-ran `pnpm check` — clean. Re-ran the two mail test files directly — 8/8 still pass, no behavior regression.

- [ ] 4.0 Mailbox connectors: hand-rolled IMAP/POP3 connection testing
  - [x] 4.1 Generate the test-only self-signed TLS fixture with the bash tool (not TDD — a static asset): `openssl req -x509 -newkey rsa:2048 -nodes -keyout backend/src/mailboxes/test/fixtures/test-key.pem -out backend/src/mailboxes/test/fixtures/test-cert.pem -days 3650 -subj "/CN=localhost"`. Add a one-line comment file or README noting it's test-only, never used for anything sensitive. **Done** — `test-cert.pem`/`test-key.pem` generated (Git Bash required `MSYS_NO_PATHCONV=1` to stop path-mangling `/CN=localhost`), `fixtures/README.md` added.
  - [x] 4.2 RED: Write-test agent writes:
    - `backend/src/mailboxes/test/fixtures.ts`: helper functions building in-process fake TLS IMAP and POP3 servers on `localhost` using `node:tls.createServer` + the fixture cert/key — one variant that accepts a specific username/password (IMAP: replies `OK` to `LOGIN` with matching creds, else `NO`; POP3: replies `+OK` to matching `USER`/`PASS`, else `-ERR`), and one variant that accepts the TCP/TLS connection but never writes a response (for timeout tests). Each returns `{ port, close() }`.
    - `backend/src/mailboxes/test/connectors.test.ts`: for both `imap.ts` and `pop3.ts`, `testConnection()` against the fake server resolves `{ ok: true }` with correct credentials; resolves `{ ok: false, reason: "authentication failed" }` with wrong credentials; resolves `{ ok: false, reason: ... }` (not throwing) against a port nothing is listening on (`ECONNREFUSED`); resolves `{ ok: false }` after roughly `MAILBOX_CONNECT_TIMEOUT_MS` against the "never responds" fake server (pass a short override, e.g. 200ms, so the test doesn't wait 10s); and — using a real TLS connection to the fixture server _without_ the test-only cert-trust override — asserts `console.error` (spy it) is called with the host and a certificate-related indicator, proving the strict-by-default path both fails the connection and logs distinctly. **Chose test-only fields:** `caCert?: string` (trust this PEM in addition to the system store — keeps `rejectUnauthorized: true` everywhere, per FR-5) and `connectTimeoutMs?: number` (per-call timeout override).
  - [x] 4.3 CONFIRM RED: Run `pnpm --filter @pigeon/backend test connectors` with the bash tool — verify it fails (connector modules don't exist). **Confirmed:** "Cannot find module '../connectors/index'".
  - [x] 4.4 GREEN: Write-code agent implements:
    - `backend/src/mailboxes/connectors/types.ts` — the `MailboxConnector` interface (PRD FR-4), with the test-only TLS options override as a separate, clearly-marked internal parameter (not part of the public `testConnection` request shape used by `routes.ts`).
    - `backend/src/mailboxes/connectors/imap.ts` and `pop3.ts` per PRD FR-5: single connect+auth timeout defaulting to `MAILBOX_CONNECT_TIMEOUT_MS`/10000, strict TLS validation, `console.error` logging of the host + TLS error code specifically on certificate-validation failures.
    - `backend/src/mailboxes/connectors/index.ts` — `getConnector(protocol: "imap" | "pop3")`.
    - Also extracted `backend/src/mailboxes/connectors/shared.ts` (`testTlsConnection`) up front to avoid duplicating the connect/timeout/cert-logging/line-reading plumbing between `imap.ts`/`pop3.ts`.
  - [x] 4.5 CONFIRM GREEN: Run the same test command — verify all pass. **Confirmed:** 10/10 passed on first run.
  - [x] 4.6 REFACTOR: Shared plumbing already factored out in 4.4; reviewed all 4 files, clean and minimal — no further refactor needed.
  - [x] 4.7 CHECK PHASE: Run `pnpm check` with the bash tool. **Confirmed:** lint clean, all 3 workspaces typecheck clean.

- [ ] 5.0 Mailboxes service + routes (`POST /api/mailboxes`, `DELETE /api/mailboxes/:id`)
  - [x] 5.1 RED: Write-test agent writes `backend/src/mailboxes/test/routes.test.ts` (integration; boots `withTestDb`, runs migrations, mounts `mailboxesRoutes(db, vault)` built with a test `createVault(TEST_KEY)`, and injects a fake connector via dependency injection so no real network is used). Cover, behind a valid session cookie (mint one directly in the `sessions` table, same pattern as `sessions-login.test.ts`):
    - Passing test → `201`, response body shaped like `EmailAccount` (`unread: 0`), row persisted, `password_ciphertext` column is not the plaintext password and `vault.open()` on it recovers the original.
    - Failing test → `422 { code: "connection_failed" }`, **zero rows** in `mailboxes` afterward.
    - `provider: "mock"` → `400 { code: "provider_not_supported" }`, connector never invoked.
    - `tls: false` → `400 { code: "tls_required" }`.
    - Connecting the same `(user, address)` twice → second call `409 { code: "mailbox_already_connected" }`.
    - `DELETE` on your own mailbox → `200 { ok: true }`, row gone.
    - `DELETE` on another user's mailbox id → `404`.
    - Both routes without a session cookie → `401`.
  - [x] 5.2 CONFIRM RED: Run `pnpm --filter @pigeon/backend test mailboxes/test/routes` with the bash tool — verify it fails (routes don't exist / 404). **Confirmed:** "Cannot find module '../routes'". Designed signature: `mailboxesRoutes(db, vault, getConnectorFn?)`, the third arg a DI hook for tests.
  - [x] 5.3 GREEN: Write-code agent implements:
    - `backend/src/mailboxes/service.ts` — `connectMailbox(db, vault, connector, userId, input)` (connector test first → seal → insert, catching a `23505` unique-violation on `(user_id, address)` as the duplicate result instead of a separate SELECT-then-INSERT) and `removeMailbox(db, userId, mailboxId)` (ownership-scoped delete), per PRD FR-6..FR-9.
    - `backend/src/mailboxes/routes.ts` — `mailboxesRoutes(db, vault, getConnectorFn = getConnector)` exporting the Hono sub-app: Zod-validates the body per FR-6, calls `service.ts`, translates results to the documented status codes, mounts both routes behind `requireAuth(db)`.
  - [x] 5.4 CONFIRM GREEN: Run the same test command — verify all pass. **Confirmed:** 8/8 passed (~63s, 8 embedded-postgres cluster boots).
  - [x] 5.5 REFACTOR: Implementation already clean and minimal on review; no refactor needed.
  - [x] 5.6 CHECK PHASE: Run `pnpm check` with the bash tool. **Confirmed:** lint clean, all 3 workspaces typecheck clean.

- [ ] 6.0 Dashboard aggregator (`GET /api/dashboard`)
  - [x] 6.1 RED: Write-test agent writes `backend/src/mailboxes/test/dashboard.test.ts` (integration): with a session cookie and two connected mailboxes seeded, `GET /api/dashboard` returns `200` with `user.email`/`user.name` matching the session, `user.plan.inboxLimit` matching `tierLimits(user.tier).maxMailboxes`, `accounts` containing exactly the two seeded mailboxes (correct shape, `unread: 0`), and `stats: {urgent:0,important:0,everything:0}`, `emails: []`, `channels: []`, `digest.enabled === false`, `lastSync === "Never"`. Without a cookie → `401`. Also covers zero-mailboxes → `accounts: []`. Designed signature: `dashboardRoutes(db: Db): Hono`.
  - [x] 6.2 CONFIRM RED: Run `pnpm --filter @pigeon/backend test mailboxes/test/dashboard` with the bash tool — verify it fails (route doesn't exist). **Confirmed:** "Cannot find module '../dashboard'".
  - [x] 6.3 GREEN: Write-code agent implements `backend/src/mailboxes/dashboard.ts` — `dashboardRoutes(db)` per PRD §3.2.5/FR-10, with each placeholder value inline-commented with the feature that owns replacing it.
  - [x] 6.4 CONFIRM GREEN: Run the same test command — verify all pass. **Confirmed:** 3/3 passed.
  - [x] 6.5 REFACTOR: Implementation already clean (`planFor`/`loadAccounts` helpers already factored out, no secret columns selected); no refactor needed.
  - [x] 6.6 CHECK PHASE: Run `pnpm check` with the bash tool. **Confirmed:** lint clean, all 3 workspaces typecheck clean.

- [ ] 7.0 OAuth providers stub (`GET /api/oauth/providers`)
  - [x] 7.1 RED: Write-test agent writes `backend/src/oauth/test/routes.test.ts`: with a valid session, `GET /api/oauth/providers` → `200 { providers: [] }`; without a session → `401`. Designed signature: `oauthRoutes(db: Db): Hono`.
  - [x] 7.2 CONFIRM RED: Run `pnpm --filter @pigeon/backend test oauth` with the bash tool — verify it fails. **Confirmed:** "Cannot find module '../routes'".
  - [x] 7.3 GREEN: Write-code agent implements `backend/src/oauth/routes.ts` — `oauthRoutes(db)` mounting the single stub route behind `requireAuth`.
  - [x] 7.4 CONFIRM GREEN: Run the same test command — verify all pass. **Confirmed:** 2/2 passed.
  - [x] 7.5 REFACTOR: n/a — trivial stub, nothing to clean up.
  - [x] 7.6 CHECK PHASE: Run `pnpm check` with the bash tool.

- [ ] 8.0 Wire everything into `server.ts`
  - [x] 8.1 RED: Write-test agent adds a `backend/test/app-routes.test.ts` (or extends `readyz.test.ts`) asserting that `createApp(...)` — built the same way `server.ts`'s `isMain` block builds it — actually answers `POST /api/auth/signup`-style requests without a 404 (i.e. the auth router Feature 2 already built is reachable), and that `GET /api/mailboxes`... no such GET exists, so instead assert `POST /api/mailboxes` without a cookie returns `401` (not `404`) and `GET /api/dashboard`/`GET /api/oauth/providers` without a cookie return `401` (not `404`) — proving all four routers are actually mounted on the app the server serves. Designed against new signature `createApp(db, mail, vault)`.
  - [x] 8.2 CONFIRM RED: Run `pnpm --filter @pigeon/backend test app-routes` with the bash tool — verify it fails with `404`s (nothing mounted today; this also covers the pre-existing Feature 2 gap where `authRoutes` was never mounted). **Confirmed:** "expected 404 not to be 404" on the signup check (test stopped at the first assertion, as expected).
  - [x] 8.3 GREEN: Write-code agent updates `backend/src/server.ts`: `createApp(db, mail, vault)` mounts `authRoutes(db, mail)`, `mailboxesRoutes(db, vault)`, `dashboardRoutes(db)`, `oauthRoutes(db)` at `"/"` alongside `/healthz`/`/readyz`. Updated the `isMain` startup block to construct `mail`/`vault` from `config`. Also fixed the resulting regression in `backend/test/readyz.test.ts` (its four `createApp(db)` calls needed the new 3-arg signature) — purely additive, zero behavior change.
  - [x] 8.4 CONFIRM GREEN: Run the same test command — verify all pass. **Confirmed:** 5/5 passed (1 app-routes + 4 readyz), no regressions.
  - [x] 8.5 REFACTOR: Implementation already clean; no refactor needed.
  - [x] 8.6 CHECK PHASE: Run `pnpm check` with the bash tool. **Confirmed:** lint clean, all 3 workspaces typecheck clean.

- [ ] 9.0 Frontend: remove the "mock" provider option
  - [x] 9.1 GREEN (no backend behavior to RED against — a UI/data trim): write-code agent removes the `"mock"` entry from `PROVIDERS` in `frontend/src/lib/providers.ts`, and removes the `provider() !== "mock"` conditionals in `AddInboxDialog.tsx` (protocol picker, host/port fields, and the `submit()` overrides for `tls`/`host`/`protocol` are always the real values now).
  - [x] 9.2 CHECK PHASE: Run `pnpm --filter @pigeon/frontend build` with the bash tool — verify it succeeds (the frontend's typecheck/smoke gate, per coding guidelines). **Confirmed:** build succeeded, 9 pages built.

- [ ] 10.0 Final: full suite + manual end-to-end check
  - [x] 10.1 Run `pnpm check:all` with the bash tool across the whole repo — all must pass. **Confirmed:** 23/23 test files, 141/141 tests passed; lint and typecheck (all 3 workspaces) clean. `pnpm --filter @pigeon/frontend build` also confirmed green in 9.2.
    - **Regression found + fixed along the way:** the first `check:all` run surfaced that making `VAULT_MASTER_KEY` required in every `NODE_ENV` (Phase 3) broke two pre-existing CLI integration tests (`backend/test/migrate-cli.test.ts`, `backend/src/auth/test/invite-cli.test.ts`) that call `main()` after only setting `DATABASE_URL`/`NODE_ENV` in `process.env`, not `VAULT_MASTER_KEY` — `parseConfig` now threw, so `main()` returned exit code 1 instead of 0. Fixed by adding the same fixed test key to those env-setting blocks (a single shared `withCliEnv` helper in `invite-cli.test.ts`, two inline blocks in `migrate-cli.test.ts`). Also caught and fixed a second, unrelated stale assertion in `migrate-cli.test.ts` (hardcoded migration count of `3`, now `4` after this feature's `0004_mailboxes.sql`). Re-ran the full suite after the fix — 141/141 green, no other regressions.
  - [x] 10.2 Manual verification instructions for the user (AC-12 — not automated, per project convention that `pnpm build` is the frontend gate and manual browser smoke is the user's call): start Postgres + backend (`pnpm dev:db`, `pnpm --filter @pigeon/backend dev`) and the frontend (`pnpm --filter @pigeon/frontend dev`), log in, open "Add an inbox," pick "Other (IMAP/POP3)" or a real provider, and connect a real test mailbox (or a throwaway one) to confirm the connection-test/save/remove flow behaves as expected end-to-end.

- [x] Commit message (not committed — user manages VCS): `feat(mailboxes): add IMAP/POP3 inbox connectors with encrypted credential storage behind a provider-agnostic interface, and stand up GET /api/dashboard`

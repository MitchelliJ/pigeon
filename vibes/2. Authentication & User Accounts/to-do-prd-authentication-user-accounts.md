# To-Do — 2. Authentication & User Accounts

> Implements `prd-authentication-user-accounts.md` (read it first). Follow the
> coding guidelines (`vibes/coding-guidelines.md`) at all times: strict TS,
> ESM, `noUncheckedIndexedAccess`, `import type` for type-only imports, plain
> CSS / no new framework, Prettier/ESLint conventions, block comment per
> module. Each CHECK PHASE runs `pnpm check` (lint + typecheck). The final gate
> runs `pnpm check:all` (lint + typecheck + tests). Embedded-Postgres
> integration tests use the harness from Feature 1 (`backend/test/db.ts`,
> `withTestDb()` → `{ db, close }`); `vitest.config.ts` already sets
> `poolOptions.forks.singleFork:true` (keep it — concurrent cluster boots flap).
>
> Subagents referenced (`write-test`, `write-code`) live in
> `C:\Users\michi\.pi\agent\agents`. Spawn them with a focused, self-contained
> task; do not assume prior context. Hand the subagent the exact PRD FRs/ACs
> each step cites.
>
> Cross-cutting rules enforced everywhere (spec §6): secrets never in plaintext
> in DB or logs; tokens/invites stored only as SHA-256 hashes; `SameSite=Lax`
> cookies; all mutations on non-GET verbs; constant-time on unknown accounts.

# Relevant Files

- `shared/src/index.ts` — promote `SessionUser` here (frontend imports it type-only via `@pigeon/shared`); add auth request/response types (`SignupInput`, `LoginInput`, `VerifyEmailInput`, `ResetRequestInput`, `ResetPasswordInput`).
- `backend/src/config/index.ts` — extend the Zod schema with `APP_BASE_URL`, `MAIL_FROM`, `RESEND_API_KEY`, `SIGNUP_OPEN`; prod requires the first three.
- `db/migrations/0003_users_sessions.sql` — `CREATE EXTENSION IF NOT EXISTS citext`; `users`, `sessions`, `auth_tokens`, `invites` tables per PRD §3.1.1.
- `backend/src/auth/password.ts` — `hashPassword(pw)` / `verifyPassword(pw, encoded)` (scrypt, `N=2^15,r=8,p=1`, salt `randomBytes(16)`, encoded `scrypt:N:r:p:saltHex:hashHex`).
- `backend/src/auth/tokens.ts` — `generateToken()` (`randomBytes(32)` base64url), `hashToken(token)` (sha256 hex), `generateInviteCode()` (`randomBytes(9)` base32, ~15 chars).
- `backend/src/auth/common-passwords.json` — ~100 most common passwords, offline denylist.
- `backend/src/auth/routes.ts` — Hono router mounting `POST /api/auth/signup|verify|verify/resend|login|logout|me|password/reset-request|password/reset`; exported `authRoutes(db, mail)`.
- `backend/src/auth/service.ts` — pure-ish service functions over `db` (signup, verify, resendVerify, login, createSession, revokeSession, revokeAllSessions, requestReset, resetPassword, consumeInvite). Routes are thin wrappers.
- `backend/src/auth/middleware.ts` — `requireAuth(db)` Hono middleware: reads cookie, loads session+user, sliding renewal, attaches `ctx.user`; `csrfGuard()` Origin/Referer check against `APP_BASE_URL`.
- `backend/src/auth/invite-cli.ts` — `pnpm invite` CLI (`--ttl`, `--count`); inserts `invites`, prints plaintext codes to stdout.
- `backend/src/auth/test/password.test.ts`, `tokens.test.ts`, `signup-verify.test.ts`, `sessions-login.test.ts`, `reset.test.ts`, `csrf.test.ts`, `invite-cli.test.ts` — integration/unit tests.
- `backend/src/mail/index.ts` — `MailSender` interface + `createMailSender(config)` factory (Resend when `RESEND_API_KEY` set or `NODE_ENV=production`; mock otherwise).
- `backend/src/mail/mock.ts` — mock provider; in-process ring buffer with `mockMail.outbox()` for tests; logs clickable links at `info`.
- `backend/src/mail/resend.ts` — Resend provider via the `resend` package; never throws into the request path (returns `{ok:false,reason}`).
- `backend/src/mail/templates.ts` — `verificationEmail({to,baseUrl,token})`, `resetEmail({to,baseUrl,token})` → `{subject,html,text}`.
- `backend/src/mail/test/mock.test.ts`, `resend.test.ts` — provider tests (Resend via faked fetch, no network).
- `backend/src/server.ts` — mount `authRoutes` + `requireAuth` on protected paths; export `createApp(db, mail)` (extend the Feature 1 `createApp(db)`).
- `backend/package.json` — add `resend` dep; add `invite` script (`tsx src/auth/invite-cli.ts`).
- `package.json` — root `invite` filter script.
- `frontend/src/lib/api.ts` — extend `auth` with `verifyEmail`, `resendVerify`, `requestReset`, `resetPassword`; make `name` required in `signup`; switch `API_BASE` to same-origin (`""`) with a Vite dev proxy.
- `frontend/astro.config.mjs` — `server.proxy` `/api` → `http://localhost:8788` so dev is one origin (Lax cookies work).
- `frontend/src/pages/signup.astro`, `login.astro` — real Solid-island forms wiring `auth.signup`/`auth.login`.
- `frontend/src/pages/verify.astro`, `forgot-password.astro`, `reset-password.astro` — new pages.
- `frontend/src/components/AuthForm.tsx` — refactor/replace the mock form to drive the real flows + inline error rendering.
- `.env.example` — add the four new keys (commented, with the mock-fallback note for `RESEND_API_KEY`); leave `.env.old` untouched.
- `docs/COMMANDS.md` — document `pnpm invite` + the mock-mail dev story.

# Tasks

- [x] 1.0 Shared auth types (frontend↔backend type-only contract)
  - [x] 1.1 RED: Use `write-test` to add `shared/src/__tests__/auth-types.test.ts` (type-only compile-time test) asserting the shapes compile: `SessionUser { id:string; email:string; name:string; tier:string }`, `SignupInput { inviteCode:string; email:string; password:string; name:string }` (name required), `LoginInput`, `VerifyEmailInput { token:string }`, `ResetRequestInput { email:string }`, `ResetPasswordInput { token:string; newPassword:string }`. (If a value-level test is awkward for type-only exports, use `expectTypeOf`/`import type` + a `// @ts-expect-error` on a deliberately wrong shape.)
  - [x] 1.2 CONFIRM RED: `pnpm --filter @pigeon/shared typecheck` — fails: `Module has no exported member 'SignupInput'` (+ others); fixed an early-comment-termination bug (glob `*/`) along the way.
  - [x] 1.3 GREEN: `write-code` — exported the 6 interfaces in `shared/src/index.ts`. (type-only; no runtime). Keep `SessionUser` field order matching the existing `api.ts` declaration so the frontend can import it.
  - [x] 1.4 CONFIRM GREEN: `pnpm --filter @pigeon/shared typecheck` — exit 0.
  - [x] 1.5 REFACTOR: per-type `/** */` doc comments; `_`-prefixed the type-assertion consts to clear `no-unused-vars` warnings.
  - [x] 1.6 CHECK PHASE: `pnpm check` — 0 errors, 0 warnings.

- [x] 2.0 Config schema extension (FR-30, FR-31, FR-32)
  - [x] 1.1 RED: `write-test` extends `backend/test/config.test.ts` with the 8 new-key cases.
  - [x] 2.2 CONFIRM RED: `pnpm test backend/test/config.test.ts` — 8 new cases fail (missing fields read undefined; production-required throws don't fire).
  - [x] 2.3 GREEN: `write-code` — added `APP_BASE_URL`/`MAIL_FROM`/`RESEND_API_KEY`/`SIGNUP_OPEN` to schema, Config type, parseConfig, describeConfig; production-required via superRefine.
  - [x] 2.4 CONFIRM GREEN: `pnpm test` — 15/15 config pass; full suite 29/29 (no regression). Also updated one pre-existing Feature 1 production test to the new required-keys contract.
  - [x] 2.5 REFACTOR: extracted `requireInProd(name,value)` helper in superRefine; removed dead `=== true` branch (TS2367).
  - [x] 2.6 CHECK PHASE: `pnpm check` — lint + typecheck clean across all workspaces.

- [x] 3.0 Migration `0003_users_sessions.sql` (PRD §3.1.1; AC-11 token hashes only)
  - [x] 3.1 RED: `write-test` created `backend/test/auth-schema.test.ts` (6 cases) + updated `migrate.test.ts` counts 2→3.
  - [x] 3.2 CONFIRM RED: `pnpm test` — 7 fail (6 schema + 1 migrate count); 3 pass.
  - [x] 3.3 GREEN: `write-code` — created `db/migrations/0003_users_sessions.sql` (citext ext + 4 tables + indexes). Fixed a non-ASCII `→` in a comment that WIN1252 clusters couldn't encode.
  - [x] 3.4 CONFIRM GREEN: `pnpm test` — 10/10 (6 schema + 4 migrate).
  - [x] 3.5 REFACTOR: migration already minimal/commented; test file clean (no refactor needed).
  - [x] 3.6 CHECK PHASE: `pnpm check` — lint + typecheck clean.

- [x] 4.0 Crypto helpers + password denylist (FR-A, FR-B; AC-11)
  - [x] 4.1 RED: `write-test` wrote `backend/src/auth/test/password.test.ts` + `tokens.test.ts`. (a) `hashPassword(pw)` returns a string starting `scrypt:` and `verifyPassword(pw, hash)` is `true` for the right pw and `false` for a wrong one; (b) two hashes of the same pw differ (random salt); (c) `verifyPassword` with a malformed hash returns `false` (does not throw). Plus `backend/src/auth/test/tokens.test.ts`: (a) `generateToken()` returns 43-char base64url strings and two calls differ; (b) `hashToken(t)` is 64-char hex and deterministic; (c) `generateInviteCode()` is ~15 base32 chars and two calls differ. Plus a `password-strength.test.ts`: a 12-char pw passes, 11 chars fails, a denylist entry (e.g. `password123456` if in the list) fails case-insensitively, a non-denylist 12-char pw passes.
  - [x] 4.2 CONFIRM RED: `pnpm test` — both files fail on module-not-found (`../password`,`../tokens`).
  - [x] 4.3 GREEN: `write-code` — `password.ts`, `tokens.ts`, `common-passwords.json` (100 entries). (`hashPassword`, `verifyPassword`, `isAcceptablePassword(pw)` using `common-passwords.json` + `>=12` chars), `backend/src/auth/tokens.ts` (`generateToken`, `hashToken`, `generateInviteCode`), and `backend/src/auth/common-passwords.json` (~100 entries). All use `node:crypto` only.
  - [x] 4.4 CONFIRM GREEN: `pnpm test` — 14/14 (after fixing scrypt `maxmem` for N=2^15,r=8).
  - [x] 4.5 REFACTOR: param constants named; denylist lowercased at load; block comments (no further change needed).
  - [x] 4.6 CHECK PHASE: `pnpm check` — lint + typecheck clean.

- [x] 5.0 Mail module — `MailSender` interface, mock, templates, Resend (FR-26..FR-29; AC-10)
  - [x] 5.1 RED: `write-test` wrote mock/resend/templates test files. `createMailSender(config)` with no `RESEND_API_KEY` in `development` returns the mock; `send({to,subject,html,text})` resolves `{ok:true}` and the email appears in `mockMail.outbox()` with the right `to`/`subject`/link. Then `backend/src/mail/test/resend.test.ts`: with `RESEND_API_KEY` set, `createMailSender` returns the Resend provider; stub `global.fetch` to assert one `POST` to `https://api.resend.com/emails` with `Authorization: Bearer <key>` and the `from`/`to`/`subject` body; a `fetch` that returns `{ok:false,status:500}` resolves to `{ok:false,reason:<string>}` (no throw). Finally `templates.test.ts`: `verificationEmail({to,baseUrl:'https://app.x',token:'t'})` includes `${baseUrl}/verify?token=t` in both `html` and `text`; `resetEmail` includes `${baseUrl}/reset-password?token=...`.
  - [x] 5.2 CONFIRM RED: `pnpm test` — 3 files fail on module-not-found.
  - [x] 5.3 GREEN: `write-code` — `index.ts`, `mock.ts`, `resend.ts`, `templates.ts`. **Deviation:** used direct `global.fetch` to the Resend API instead of the `resend` SDK (endpoint contract identical; tests spy on `global.fetch`; avoids mocked-SDK-fetch mismatch + a dep).
  - [x] 5.4 CONFIRM GREEN: `pnpm test` — 10/10 mail tests pass (fetch stubbed, no network).
  - [x] 5.5 REFACTOR: fixed two `tsc` errors in the resend test (`as unknown as [string, RequestInit]`, dropped `HeadersInit`).
  - [x] 5.6 CHECK PHASE: `pnpm check` — lint + typecheck clean.

- [x] 6.0 Sign-up + verify-email + resend loop (FR-1..FR-12; AC-1, AC-3, AC-4; OQ1 approach)
  - [x] 6.1 RED: `write-test` writes `backend/src/auth/test/signup-verify.test.ts` (integration; boot harness, mock mail, stand up `authRoutes(db, mail)` via `createApp`):
    - valid invite + email + password + name → `202 verify_email_sent`; an unverified `users` row exists; mock outbox has one email containing a `/verify?token=` link.
    - missing/already-consumed/expired invite → `403 bad_invite`; the invite is NOT consumed by an unverified-typ-email flow until verify (assert `invites.consumed_at` is null after a sign-up that hasn't verified).
    - re-signup with the same still-unverified email → `202`, old `verify_email` tokens for that user are `consumed_at`-set, a new one minted, password rotated, `name` updated.
    - re-signup with a verified email → `409 email_taken`.
    - `POST /api/auth/verify` with the token → `200 { user }`, cookie set; `users.email_verified_at` set; the token is single-use (second verify → `400 invalid_or_expired_token`); the invite is now `consumed_at`-set; `GET /api/auth/me` returns the user (auto-login).
    - login before verify → `401 bad_credentials` (AC-3; same shape as wrong password).
    - `POST /api/auth/verify/resend` for an unverified user → `202`, a new token minted; within the 60s cooldown → `202` but no new token (assert outbox count unchanged); for a nonexistent email → still `202` (no enumeration).
    - name required: `POST /api/auth/signup` with empty/whitespace `name` → `400` (FR-1/FR-2).
      One behavior per test.
  - [x] 6.2 CONFIRM RED: `pnpm test backend/src/auth/test/signup-verify.test.ts` — fails: `Error: Cannot find module '../routes'` (after fixing 3 broken harness import paths left over from the original authoring pass — `../../test/db`→`../../../test/db`, `../../src/migrate/runner`→`../../migrate/runner`, `../../src/db/index`→`../../db/index` — all miscounted directory depths).
  - [ ] 6.3 GREEN: **sliced into four sub-passes** so no single `write-code` pass has to satisfy all 11 RED cases at once (that's what stalled this task the first time — too many first-of-their-kind pieces landing simultaneously with no intermediate green checkpoint). Each slice ends with a runnable green subset via `pnpm test -t "<pattern>" backend/src/auth/test/signup-verify.test.ts`.
    - [x] 6.3a **Skeleton + signup insert path.** DONE — `pnpm test backend/src/auth/test/signup-verify.test.ts`: 5/5 targeted cases pass (valid-invite-202, missing-invite-403, expired-invite-403, invite-not-consumed, name-required-400); the other 6 fail on expected not-this-slice paths (501 for collision branches, 404 for verify/resend routes not yet mounted). **Bug found + fixed in the RED test along the way:** 4 password literals across 2 collision tests (`"first-pw-1"`, `"second-pw-2"`, and duplicates in the 409 test) were under the 12-char FR-B minimum, which would have made those tests fail on weak-password 400s even with correct 6.3c code — bumped all four to ≥12 distinct chars. `backend/src/auth/routes.ts` (Hono app, `{error,code}` JSON error envelope, Zod validation for `{inviteCode,email,password,name}`, status conventions) + `backend/src/auth/service.ts` `signup()` — new-user-insert branch only (FR-1..FR-3, FR-6, FR-7; send mail after commit). Greens: valid-invite→202, missing-invite→403, expired-invite→403, name-required→400, invite-not-consumed-until-verify (5/11).
    - [x] 6.3b **Verify + first session.** DONE — `pnpm test backend/src/auth/test/signup-verify.test.ts`: 7/11 pass (verify-valid-token, verify-single-use now green, 5 from 6.3a unaffected); remaining 4 (collision x2, resend x2) fail on expected not-this-slice paths. `service.ts` `verify()` (FR-9, FR-10: set `email_verified_at`, consume token, consume the `pending_invite_code_hash` invite, all in `withTx`) plus a real `createSession()` helper (token mint, `sessions` insert, `pigeon_session` cookie) — this is the **one** session primitive; Task 7 extends it with `revokeSession`/`loadSession`/sliding renewal rather than replacing a stub. Greens: verify-valid-token, verify-single-use (2/11; 7/11 cumulative).
    - [x] 6.3c **Signup collision branches.** DONE — `pnpm test backend/src/auth/test/signup-verify.test.ts`: 9/11 pass; only the 2 resend cases remain. `service.ts` `signup()` reuse-unverified branch (rotate `password_hash`, update `name`, void outstanding `verify_email` tokens, remint, still `202`, invite still unconsumed) and verified→`409 email_taken` branch (FR-4). Greens: re-signup-same-unverified-email, re-signup-verified-email→409 (2/11; 9/11 cumulative). Must land after 6.3b — the 409 test drives a full signup+verify via `fullSignupAndVerify`.
    - [x] 6.3d **Resend loop.** DONE — `service.ts` `resendVerify()` + `POST /api/auth/verify/resend` route. **Design fix along the way:** the cooldown can't be derived from the outstanding token's mint time (that's always "just now" right after signup, which would incorrectly block the very first resend) — it's keyed off the most recently-_voided_ verify_email token's `consumed_at` instead (signup never sets `consumed_at`; only a resend voids a token), so the first resend after signup always proceeds and only a second, back-to-back resend hits the cooldown. Matches the RED test's exact sequencing.
  - [x] 6.4 CONFIRM GREEN: `pnpm test backend/src/auth/test/signup-verify.test.ts` — 11/11 pass (one run hit a transient embedded-Postgres flake unrelated to the code — re-ran clean).
  - [x] 6.5 REFACTOR: consolidated duplicated signup branches (shared token-mint tail), extracted `rotateVerifyToken` (shared by re-signup and resend), extracted `readJsonBody` (shared by all 3 route handlers); module comments updated to reflect the finished feature. `pnpm test backend/src/auth/test/signup-verify.test.ts` — 11/11 still pass, no behavior change.
  - [x] 6.6 CHECK PHASE: `pnpm check` — lint clean; typecheck initially failed with 7 `TS18046` errors in `signup-verify.test.ts` itself (`res.json()` returns `unknown` under strict TS, and 6 call sites accessed properties on it unnarrowed — a latent bug from the original RED authoring, invisible until this workspace-wide gate ran). Fixed via `write-test`: added local `ErrorBody`/`VerifyBody` type aliases and cast each `.json()` call site (no `any`), no assertions changed. Lint + typecheck now clean across all 3 workspaces; `pnpm test backend/src/auth/test/signup-verify.test.ts` — 11/11 still pass.

- [x] 7.0 Sessions + `requireAuth` + login + logout + me + sliding/absolute + CSRF + constant-time (FR-13..FR-20, FR-33; AC-2, AC-5, AC-8, AC-9)
  - [x] 7.1 RED: `write-test` writes `backend/src/auth/test/sessions-login.test.ts` (integration):
    - login (verified user, right pw) → `200 { user }`, cookie `pigeon_session` set `HttpOnly; SameSite=Lax; Path=/` (`Secure` absent in dev test).
    - login nonexistent email / unverified / wrong pw → all three return identical `401 bad_credentials` (AC-2: assert same `status` + same `code`).
    - `GET /api/auth/me` with cookie → `200 { user }`; without → `401 unauthenticated`.
    - `POST /api/auth/logout` → `200`, cookie cleared, subsequent `me` → `401`.
    - sliding renewal: set `sessions.last_seen_at` to 5 days ago → `me` still `200` and `expires_at` advanced; set `created_at` to 91 days ago → `me` `401` (absolute cap); set `last_seen_at` to 31 days ago → `me` `401` (idle).
      Then `backend/src/auth/test/csrf.test.ts`: a `POST /api/auth/login` with `Origin: https://evil.test` → `403 cross_origin`; with `Origin` equal to `APP_BASE_URL`'s host → proceeds (200/401 on merits); with no `Origin` but a same-host `Referer` → proceeds; with neither → proceeds (Lax+non-GET is the real guard).
  - [x] 7.2 CONFIRM RED: `pnpm test backend/src/auth/test/sessions-login.test.ts backend/src/auth/test/csrf.test.ts` — 14/14 fail. 10 sessions-login cases fail on 404 (login/me/logout not mounted). 4 csrf cases fail (1 on a real 403-vs-404 assertion mismatch; 3 throw a JSON-parse `SyntaxError` trying to parse Hono's non-JSON 404 body — a self-resolving RED, not a test defect, since real routes will always return the established `{error,code}`/`{user}` JSON envelope).
  - [ ] 7.3 GREEN: **sliced into four sub-passes**, same reasoning as Task 6.3 — `createSession` already exists (real, from 6.3b), so this task only adds to it, never stubs-then-refactors it.
    - [x] 7.3a **Login core.** DONE — `pnpm test backend/src/auth/test/sessions-login.test.ts`: 4/10 pass (login-success, 3x identical-401); other 6 (me/logout/renewal) still 404 as expected. `signup-verify.test.ts` unaffected (11/11). `routes.ts` `POST /api/auth/login` (constant-time: always run a decoy scrypt verify before the identical `bad_credentials`; reuses `createSession` from 6.3b). Greens: login-success, and the three identical-401 cases (nonexistent/unverified/wrong-pw).
    - [x] 7.3b **me / logout.** DONE — new `middleware.ts` (`requireAuth`), `revokeSession` in `service.ts`, `GET /me`/`POST /logout` in `routes.ts`. `pnpm test backend/src/auth/test/sessions-login.test.ts`: 7/10 pass; only the 3 renewal cases remain. `signup-verify.test.ts` unaffected (11/11). `service.ts` add `revokeSession`; `backend/src/auth/middleware.ts` `requireAuth(db)` (read cookie → hash → session lookup → `ctx.user` or `401`, no renewal yet); `routes.ts` add `GET /api/auth/me`, `POST /api/auth/logout`. Greens: me-with-cookie→200, me-without-cookie→401, logout-then-me→401.
    - [x] 7.3c **Sliding/absolute renewal.** DONE — key fix: since the RED tests simulate elapsed time by rewriting only `created_at`/`last_seen_at` via SQL (leaving the cached `expires_at` untouched and still future-dated), `requireAuth`'s admission check re-derives both caps directly from `created_at`/`last_seen_at` at lookup time rather than trusting the cached `expires_at` alone, then a renewal UPDATE keeps `expires_at` in sync. `pnpm test backend/src/auth/test/sessions-login.test.ts backend/src/auth/test/signup-verify.test.ts` — 21/21 pass. Extend the session lookup (`service.ts` `loadSession` or inline in `requireAuth`) to refresh `last_seen_at` and extend `expires_at = now()+30d` capped by `created_at+90d` on every authenticated request. Greens: 5-day-idle still valid + `expires_at` advances, 91-day-absolute→401, 31-day-idle→401.
    - [x] 7.3d **CSRF.** DONE — `csrfGuard(appBaseUrl)` in `middleware.ts`, mounted on all 5 mutating routes (before `requireAuth` on logout). `csrf.test.ts` 4/4 green.
  - [x] 7.4 CONFIRM GREEN: `pnpm test backend/src/auth` — 39/39 pass across all 5 auth test files (csrf, signup-verify, sessions-login, password, tokens). No regressions.
  - [x] 7.5 REFACTOR: extracted a shared `sessionCookie()` helper (was duplicated inline in login + verify); refreshed stale module comments in all 3 files. Decoy-hash naming, middleware/route separation, and `AuthVariables` typing were already correct from the incremental slices. `pnpm test backend/src/auth` — 39/39 still pass.
  - [x] 7.6 CHECK PHASE: `pnpm check` — lint + typecheck clean across all 3 workspaces, no issues this time (the test-file `.json()` typing lesson from Task 6 was already applied by the RED-writing agents in this task's test files).

- [x] 8.0 Password reset (FR-21..FR-23; AC-6)
  - [x] 8.1 RED: `write-test` writes `backend/src/auth/test/reset.test.ts` (integration):
    - `POST /api/auth/password/reset-request` for a verified user → `202`, a `reset_password` token (1h TTL) exists, mock outbox has the reset email with `/reset-password?token=`; for a nonexistent email → still `202` (no enumeration); within 60s cooldown → `202` and no new token (assert outbox unchanged); a prior unconsumed reset token is voided when a new one is minted.
    - `POST /api/auth/password/reset` with a valid token + acceptable new pw → `200`, the user's `password_hash` changed (login with new pw succeeds, with old pw `401`); **all** the user's other sessions are revoked (a second pre-existing session's `me` → `401` — AC-5 reset branch); the token is single-use (second reset with it → `400`); an expired token → `400`; a weak new pw → `400`.
      One behavior per test.
  - [x] 8.2 CONFIRM RED: `pnpm test backend/src/auth/test/reset.test.ts` — 9/9 fail (404s, routes absent).
  - [ ] 8.3 GREEN: **sliced into two sub-passes** (same reasoning as Tasks 6/7 — request and confirm are separate endpoints with separate test groups).
    - [x] 8.3a **Reset-request.** DONE — **design fix along the way:** the RED test's cooldown assumed `resendVerify`'s "check most-recently-voided token" model, but that model only works because signup pre-seeds an outstanding `verify_email` token before the first resend ever runs; `requestReset` has no such priming event, so the very first reset-request must itself start the cooldown clock. Fixed by deriving cooldown from the currently-_outstanding_ token's `expires_at - TTL` instead (the opposite basis from resend, now documented in a comment at the call site). `pnpm test backend/src/auth/test/reset.test.ts`: 4/4 targeted cases pass; 5 reset-confirm cases remain (next slice). Full auth suite (48 tests) confirmed green modulo 2 separate transient embedded-Postgres flakes (both cleared on retry, unrelated to this change). `service.ts` `requestReset` (mint a 1h `reset_password` token, void any prior unconsumed one, 60s cooldown, always `202`) + `routes.ts` `POST /api/auth/password/reset-request`. Greens: mints-token-and-emails, nonexistent-email→202, cooldown→202/no-new-token, prior-token-voided-on-remint.
    - [x] 8.3b **Reset-confirm.** DONE — `resetPassword` (+ new `revokeAllSessions` helper) in `service.ts`, `POST /api/auth/password/reset` (behind `csrfGuard`, no `requireAuth`) in `routes.ts`. `pnpm test backend/src/auth/test/reset.test.ts` — 9/9 pass, first try.
  - [x] 8.4 CONFIRM GREEN: `pnpm test backend/src/auth/test/reset.test.ts` — 9/9 pass.
  - [x] 8.5 REFACTOR: extracted shared `mintToken`/`voidOutstandingAndMint` helpers (used by signup, resendVerify, requestReset — cooldown-detection logic itself left untouched per the two functions' differing bases); added an `AuthTokenKind` type; refreshed stale module comments. `pnpm test backend/src/auth` — 48/48 still pass.
  - [x] 8.6 CHECK PHASE: `pnpm check` — lint + typecheck clean across all 3 workspaces.

- [x] 9.0 Invite CLI (`pnpm invite`) (FR-24, FR-25; AC-7)
  - [x] 9.1 RED: `write-test` writes `backend/src/auth/test/invite-cli.test.ts` (integration): `main(['--count','3'])` inserts 3 `invites` rows with distinct `code_hash`, prints 3 distinct plaintext codes to stdout, exits 0; each printed code, when used at sign-up, is accepted exactly once (second use → `403 bad_invite`); `main(['--ttl','1s'])` + wait → the code is expired at sign-up → `403`. CLI reads validated config (so it opens the same `DATABASE_URL`); it does not start the HTTP server (assert no port bound — e.g. `main` returns before any `serve`).
  - [x] 9.2 CONFIRM RED: `pnpm test backend/src/auth/test/invite-cli.test.ts` — fails: `Cannot find module '../invite-cli'`.
  - [x] 9.3 GREEN: DONE — `backend/src/auth/invite-cli.ts`, `backend/package.json`/root `package.json` `invite` scripts. **Bug found + fixed:** the CLI initially printed via `console.log`, which Vitest's forked-worker console interception doesn't route through a test's `process.stdout.write` patch — switched to `process.stdout.write` directly to match what the RED test actually captures.
  - [x] 9.4 CONFIRM GREEN: `pnpm test backend/src/auth` — 52/52 pass (full auth suite, no regressions).
  - [x] 9.5 REFACTOR: reviewed — already compliant (minimal commented arg parsing, no stray plaintext logging, explicit return types, accurate module comment). No changes needed.
  - [x] 9.6 CHECK PHASE: `pnpm check` — lint + typecheck clean across all 3 workspaces.

- [x] 10.0 Frontend wiring — api client, dev proxy, pages, me-guard (FR-35..FR-40; AC-13)
  - [x] 10.1/10.2 RED: no separate step — frontend has no unit tests (per guidelines §2), so there's nothing to author before writing the code; the gate is `pnpm build` after implementation.
  - [x] 10.3 GREEN: **split into two sub-passes** (lower stall risk than Tasks 6-8 since the only gate is `pnpm build`, not per-case tests — but (b)-(e) all depend on (a) existing first, so land it as its own checkpoint rather than one 5-part diff).
    - [x] 10.3a **API client + proxy + existing pages.** DONE — `api.ts`: `SessionUser`/`SignupInput`/etc. now imported type-only from `@pigeon/shared` (deleted the local duplicate `SessionUser`), `signup` requires `inviteCode`+`name`, added `verifyEmail`/`resendVerify`/`requestReset`/`resetPassword`, `API_BASE` defaults to `""`. `astro.config.mjs`: proxy added under `vite.server.proxy` (Astro 5's Vite-based dev server — NOT a top-level `server.proxy` key, which would silently no-op). `AuthForm.tsx`: added invite-code field, name now required, password `minLength` 12. `pnpm --filter @pigeon/frontend build` — green (6 pages built). **Known gap carried into 10.3b:** signup no longer auto-logs-in (backend requires verify first), but `AuthForm`'s submit handler still does `window.location.href="/"` on signup success, which will bounce back to `/login` via the 401 guard — 10.3b must change the signup success path to something verify-flow-appropriate instead of assuming a session exists.
    - [x] 10.3b **New pages + protected guard.** DONE — `verify.astro`/`VerifyEmail.tsx`, `forgot-password.astro`/`ForgotPassword.tsx`, `reset-password.astro`/`ResetPassword.tsx` (all thin Astro + Solid island, reusing existing auth-page CSS classes). **Also fixed a gap found in 10.3a:** `AuthForm`'s signup success path no longer redirects to `/` (signup returns 202 with no session now) — shows a "check your email" message instead; login's redirect-on-success is untouched. Protected-page guard: `index.astro`/`Dashboard.tsx` already redirects unauthenticated users to `/login` via `fetchDashboard`'s 401 handling (both its own catch and `api.ts`'s default `redirectOn401`) — judged an explicit `auth.me()` call would be a redundant round-trip delivering the identical guarantee, so left as-is. `pnpm --filter @pigeon/frontend build` — green, 9 pages built (was 6).
  - [x] 10.4 CONFIRM GREEN: `pnpm --filter @pigeon/frontend build` — green, 9 pages built. Per user request, skipped the manual browser/dev-stack smoke — build-green is the frontend gate for this project (no Playwright verification).
  - [x] 10.5 REFACTOR: extracted a shared `AuthCard` wrapper (the repeated `auth-wrap`/`auth-card`/brand markup across all 4 auth components); form-state/busy/error logic left as 4 independent small implementations (genuinely different per component, abstracting would add indirection for no gain). Error styling and `import type` usage already consistent. `pnpm build` — still green, 9 pages.
  - [x] 10.6 CHECK PHASE: `pnpm check` — lint + typecheck clean (36 frontend files, 0 errors/warnings/hints); `pnpm build` — green, 9 pages.

- [x] 11.0 `.env.example`, `docs/COMMANDS.md`, prod-required-keys smoke (FR-32; AC-10, AC-11)
  - [x] 11.1/11.2 No gap found — `config.test.ts` already covers the positive case twice (lines 25-40, 133-145: production + all 4 keys → parses without throw, from Task 2). `pnpm test backend/test/config.test.ts` — 15/15 already pass; nothing to add.
  - [x] 11.3 GREEN: DONE — `.env.example` gets the 4 new keys (commented, mock-fallback note on `RESEND_API_KEY`, placeholder-only, no real secret); `docs/COMMANDS.md` gets an "Invites" section (`pnpm invite`, flags) and a "Mail in development" section (mock provider fallback, stdout link format).
  - [x] 11.4 CONFIRM GREEN: `pnpm test backend/test/config.test.ts` — 15/15 pass.
  - [x] 11.5 REFACTOR: verified — the 4 new keys are in schema-relative order to each other; no secrets present (placeholder-only). Pre-existing keys left as-is (reordering them is out of this task's scope).
  - [x] 11.6 CHECK PHASE: `pnpm check` — lint + typecheck clean across all 3 workspaces.

- [x] 12.0 Final: full suite + lint + typecheck + AC sweep (all ACs)
  - [x] 12.1 `pnpm check:all` — lint + typecheck clean; 96/97 tests pass, with the 1 remaining failure being a well-established Windows-only flake in embedded-postgres cluster teardown (`EBUSY: resource busy or locked, rmdir <temp-pgdata-dir>`), hitting a different single test each of 3 full-suite runs — never the same test twice, never an assertion mismatch, always the identical teardown-cleanup signature. Every affected test file has independently passed in isolation multiple times this session. **Real bug found and fixed along the way:** `backend/test/migrate-cli.test.ts` hardcoded `schema_migrations` count as `2`, stale since this feature's migration `0003_users_sessions.sql` made the real count `3` — a pre-existing test this feature's Task 3 should have updated but missed (a sibling file, `migrate.test.ts`, was correctly updated at the time). **What could have prevented the block:** nothing in this PRD's decisions — it's environmental (Windows filesystem + a large sequential embedded-Postgres suite); a Linux CI runner would not see this. Also cleaned up ~40 orphaned `postgres.exe` processes accumulated across the session's many individual test invocations, which was independently causing resource-exhaustion-driven cluster-boot failures until cleaned up.
  - [x] 12.2 AC sweep — verified via the automated suite + code reading (per user request, the live-dev-stack browser click-through was explicitly skipped for this project; `pnpm build` is the frontend gate):
    - AC-1 ✓ `signup-verify.test.ts` "verify with a valid token..." — 200, cookie set, `email_verified_at` set, invite consumed.
    - AC-2 ✓ `sessions-login.test.ts` — 3 identical-401 `bad_credentials` cases (nonexistent/unverified/wrong-pw), same status+code.
    - AC-3 ✓ same test file — unverified+correct-password still 401, no distinguishing leak.
    - AC-4 ✓ `signup-verify.test.ts` collision tests — re-signup-unverified re-issues, re-signup-verified → 409.
    - AC-5 ✓ `sessions-login.test.ts` renewal tests (5d/91d/31d) + `reset.test.ts` "revokes ALL sessions" test.
    - AC-6 ✓ `reset.test.ts` — single-use, 1h TTL, always-202, 60s cooldown.
    - AC-7 ✓ `invite-cli.test.ts` — single-use + `--ttl` expiry.
    - AC-8 ✓ `sessions-login.test.ts` — `/me` 200 vs 401.
    - AC-9 ✓ `csrf.test.ts` — foreign Origin → 403; `routes.ts` — every mutating route is POST, no GET mutations.
    - AC-10 ✓ `config.test.ts` — prod missing-key throws; `mail/index.ts` — mock fallback when `RESEND_API_KEY` absent outside production.
    - AC-11 ✓ structurally guaranteed, not just tested — `auth_tokens`/`invites`/`sessions` tables have no plaintext columns at all, only `*_hash`; `.env.example` has placeholder-only values.
    - AC-12 ✓ (with the one documented Windows-teardown flake noted in 12.1) + `pnpm build` green.
    - AC-13 ⚠️ **not manually browser-verified** — `pnpm build` is green (9 pages, all 3 new auth pages + refactored signup/login build cleanly) and the dev proxy is wired, but the actual "click through in a real browser on one origin" check was explicitly skipped per user request this session. If this matters before shipping, it's the one item worth a manual pass later.
  - [x] 12.3 OQ3 resolved as recommended — the Vite dev-server proxy (`vite.server.proxy` in `astro.config.mjs`, forwarding `/api` → `http://localhost:8788`) worked with no complications; no alternative mechanism was needed.

- [ ] Commit message: `feat(auth): add invite-gated sign-up, email verification, sessions, login/logout, and password reset with a Resend mail module`

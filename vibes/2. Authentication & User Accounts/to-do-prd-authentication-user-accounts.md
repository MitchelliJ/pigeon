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

- [ ] 1.0 Shared auth types (frontend↔backend type-only contract)
  - [ ] 1.1 RED: Use `write-test` to add `shared/src/__tests__/auth-types.test.ts` (type-only compile-time test) asserting the shapes compile: `SessionUser { id:string; email:string; name:string; tier:string }`, `SignupInput { inviteCode:string; email:string; password:string; name:string }` (name required), `LoginInput`, `VerifyEmailInput { token:string }`, `ResetRequestInput { email:string }`, `ResetPasswordInput { token:string; newPassword:string }`. (If a value-level test is awkward for type-only exports, use `expectTypeOf`/`import type` + a `// @ts-expect-error` on a deliberately wrong shape.)
  - [ ] 1.2 CONFIRM RED: `pnpm --filter @pigeon/shared test` (or `pnpm typecheck`) — fails: types not exported.
  - [ ] 1.3 GREEN: `write-code` — in `shared/src/index.ts` export the `interface`s above (type-only; no runtime). Keep `SessionUser` field order matching the existing `api.ts` declaration so the frontend can import it.
  - [ ] 1.4 CONFIRM GREEN: typecheck passes.
  - [ ] 1.5 REFACTOR: ensure `import type` only, no value shipped; block comment on the file.
  - [ ] 1.6 CHECK PHASE: `pnpm check`.

- [ ] 2.0 Config schema extension (FR-30, FR-31, FR-32)
  - [ ] 2.1 RED: `write-test` extends `backend/test/config.test.ts` (Feature 1) with: (a) `NODE_ENV=production` missing `APP_BASE_URL` throws and the message includes `APP_BASE_URL`; (b) same for `MAIL_FROM`; (c) same for `RESEND_API_KEY`; (d) `NODE_ENV=development` parses with `SIGNUP_OPEN` default `false` and `RESEND_API_KEY` optional/absent (no throw); (e) `SIGNUP_OPEN=true` parses; (f) `APP_BASE_URL` must be a valid URL (`not-a-url` throws). Inject env via the parser function with an explicit object (do not mutate `process.env` cross-test).
  - [ ] 2.2 CONFIRM RED: `pnpm test backend/test/config.test.ts` — new cases fail (keys not in schema).
  - [ ] 2.3 GREEN: `write-code` — add the four Zod fields to `backend/src/config/index.ts`; `APP_BASE_URL` = `z.string().url()`; `MAIL_FROM` = `z.string().min(1)`; `RESEND_API_KEY` = `z.string().optional()`; `SIGNUP_OPEN` = `z.boolean().default(false)`. In production require `MAIL_FROM` + `RESEND_API_KEY` + `APP_BASE_URL` (refine/discriminated check that exits non-zero naming the var, consistent with Feature 1's fail-fast). Extend `describeConfig()` to show booleans/labels only (e.g. `RESEND_API_KEY: set|unset`, `APP_BASE_URL: <host only>`, `SIGNUP_OPEN: true|false`) — never the key value.
  - [ ] 2.4 CONFIRM GREEN: `pnpm test backend/test/config.test.ts` — all pass.
  - [ ] 2.5 REFACTOR: prod-required-keys check factored into a helper; block comment updated.
  - [ ] 2.6 CHECK PHASE: `pnpm check`.

- [ ] 3.0 Migration `0003_users_sessions.sql` (PRD §3.1.1; AC-11 token hashes only)
  - [ ] 3.1 RED: `write-test` extends `backend/test/migrate.test.ts` (or new `auth-schema.test.ts`): after `runMigrations`, assert tables `users`, `sessions`, `auth_tokens`, `invites` exist; assert `users.email` is `citext` (a `WHERE email = 'Mixed@Case.com'` matches a stored `mixed@case.com`); assert `users.name` is `NOT NULL` (insert with null name fails); assert `sessions.token_hash` is `UNIQUE`; assert `auth_tokens.kind` CHECK rejects `'bogus'`; assert `invites.code_hash UNIQUE`. One assertion per test.
  - [ ] 3.2 CONFIRM RED: `pnpm test` — fails (tables don't exist).
  - [ ] 3.3 GREEN: `write-code` — create `db/migrations/0003_users_sessions.sql` with `CREATE EXTENSION IF NOT EXISTS citext;` and the four tables exactly per PRD §3.1.1 (column names, FKs `ON DELETE CASCADE`, `UNIQUE(token_hash)`, `auth_tokens.kind` CHECK, `expires_at` columns, `pending_invite_code_hash TEXT` on `users` for verify-time invite consumption per FR-10, indexes on `sessions(user_id)` and `auth_tokens(user_id,kind)`).
  - [ ] 3.4 CONFIRM GREEN: `pnpm test` — schema tests pass; existing migrate tests still green (idempotent re-run).
  - [ ] 3.5 REFACTOR: SQL grouped by table with `-- why` comments; no down-migration.
  - [ ] 3.6 CHECK PHASE: `pnpm check`.

- [ ] 4.0 Crypto helpers + password denylist (FR-A, FR-B; AC-11)
  - [ ] 4.1 RED: `write-test` writes `backend/src/auth/test/password.test.ts`: (a) `hashPassword(pw)` returns a string starting `scrypt:` and `verifyPassword(pw, hash)` is `true` for the right pw and `false` for a wrong one; (b) two hashes of the same pw differ (random salt); (c) `verifyPassword` with a malformed hash returns `false` (does not throw). Plus `backend/src/auth/test/tokens.test.ts`: (a) `generateToken()` returns 43-char base64url strings and two calls differ; (b) `hashToken(t)` is 64-char hex and deterministic; (c) `generateInviteCode()` is ~15 base32 chars and two calls differ. Plus a `password-strength.test.ts`: a 12-char pw passes, 11 chars fails, a denylist entry (e.g. `password123456` if in the list) fails case-insensitively, a non-denylist 12-char pw passes.
  - [ ] 4.2 CONFIRM RED: `pnpm test` — fails (modules absent).
  - [ ] 4.3 GREEN: `write-code` — `backend/src/auth/password.ts` (`hashPassword`, `verifyPassword`, `isAcceptablePassword(pw)` using `common-passwords.json` + `>=12` chars), `backend/src/auth/tokens.ts` (`generateToken`, `hashToken`, `generateInviteCode`), and `backend/src/auth/common-passwords.json` (~100 entries). All use `node:crypto` only.
  - [ ] 4.4 CONFIRM GREEN: `pnpm test` — all pass.
  - [ ] 4.5 REFACTOR: param constants (`N`,`r`,`p`) named constants with a comment; denylist lowercased at load; block comments.
  - [ ] 4.6 CHECK PHASE: `pnpm check`.

- [ ] 5.0 Mail module — `MailSender` interface, mock, templates, Resend (FR-26..FR-29; AC-10)
  - [ ] 5.1 RED: `write-test` writes `backend/src/mail/test/mock.test.ts`: `createMailSender(config)` with no `RESEND_API_KEY` in `development` returns the mock; `send({to,subject,html,text})` resolves `{ok:true}` and the email appears in `mockMail.outbox()` with the right `to`/`subject`/link. Then `backend/src/mail/test/resend.test.ts`: with `RESEND_API_KEY` set, `createMailSender` returns the Resend provider; stub `global.fetch` to assert one `POST` to `https://api.resend.com/emails` with `Authorization: Bearer <key>` and the `from`/`to`/`subject` body; a `fetch` that returns `{ok:false,status:500}` resolves to `{ok:false,reason:<string>}` (no throw). Finally `templates.test.ts`: `verificationEmail({to,baseUrl:'https://app.x',token:'t'})` includes `${baseUrl}/verify?token=t` in both `html` and `text`; `resetEmail` includes `${baseUrl}/reset-password?token=...`.
  - [ ] 5.2 CONFIRM RED: `pnpm test` — fails (modules absent).
  - [ ] 5.3 GREEN: `write-code` — `backend/src/mail/index.ts` (`MailSender` interface + `createMailSender(config)` factory), `mock.ts` (in-process ring buffer + `outbox()` + log link), `resend.ts` (`resend` package; `send` wraps `fetch`, returns `{ok:false,reason}` on any error, never throws), `templates.ts` (verification + reset). Factory rule: `NODE_ENV==='production'` → Resend (require key via config); else Resend if key present, else mock.
  - [ ] 5.4 CONFIRM GREEN: `pnpm test` — all pass; no network (fetch stubbed).
  - [ ] 5.5 REFACTOR: templates share a `link` helper; Resend provider's error path commented "why we swallow"; block comments.
  - [ ] 5.6 CHECK PHASE: `pnpm check`.

- [ ] 6.0 Sign-up + verify-email + resend loop (FR-1..FR-12; AC-1, AC-3, AC-4; OQ1 approach)
  - [ ] 6.1 RED: `write-test` writes `backend/src/auth/test/signup-verify.test.ts` (integration; boot harness, mock mail, stand up `authRoutes(db, mail)` via `createApp`):
    - valid invite + email + password + name → `202 verify_email_sent`; an unverified `users` row exists; mock outbox has one email containing a `/verify?token=` link.
    - missing/already-consumed/expired invite → `403 bad_invite`; the invite is NOT consumed by an unverified-typ-email flow until verify (assert `invites.consumed_at` is null after a sign-up that hasn't verified).
    - re-signup with the same still-unverified email → `202`, old `verify_email` tokens for that user are `consumed_at`-set, a new one minted, password rotated, `name` updated.
    - re-signup with a verified email → `409 email_taken`.
    - `POST /api/auth/verify` with the token → `200 { user }`, cookie set; `users.email_verified_at` set; the token is single-use (second verify → `400 invalid_or_expired_token`); the invite is now `consumed_at`-set; `GET /api/auth/me` returns the user (auto-login).
    - login before verify → `401 bad_credentials` (AC-3; same shape as wrong password).
    - `POST /api/auth/verify/resend` for an unverified user → `202`, a new token minted; within the 60s cooldown → `202` but no new token (assert outbox count unchanged); for a nonexistent email → still `202` (no enumeration).
    - name required: `POST /api/auth/signup` with empty/whitespace `name` → `400` (FR-1/FR-2).
      One behavior per test.
  - [ ] 6.2 CONFIRM RED: `pnpm test backend/src/auth/test/signup-verify.test.ts` — fails (routes/service absent).
  - [ ] 6.3 GREEN: `write-code` — implement `backend/src/auth/service.ts` (signup, resendVerify, verify) and `backend/src/auth/routes.ts` (`POST /api/auth/signup`, `/verify`, `/verify/resend`). Sign-up: FR-3 invite check (hash code, look up unconsumed/non-expired) → FR-4 email-collision rule (reuse unverified vs `409` verified vs insert) → FR-5 send mail after commit. Verify: FR-9/FR-10 set `email_verified_at`, consume token, consume the `pending_invite_code_hash` invite, create first session (delegate to the sessions task's `createSession` — if that task isn't done yet, stub a minimal session creation here and refactor in Task 7). All in `withTx`; mail send after commit. `202` everywhere that must not enumerate.
  - [ ] 6.4 CONFIRM GREEN: `pnpm test` — all signup/verify tests pass.
  - [ ] 6.5 REFACTOR: route handlers thin (validation → service → shape response); service functions take `db` + typed inputs; constant-time concerns noted.
  - [ ] 6.6 CHECK PHASE: `pnpm check`.

- [ ] 7.0 Sessions + `requireAuth` + login + logout + me + sliding/absolute + CSRF + constant-time (FR-13..FR-20, FR-33; AC-2, AC-5, AC-8, AC-9)
  - [ ] 7.1 RED: `write-test` writes `backend/src/auth/test/sessions-login.test.ts` (integration):
    - login (verified user, right pw) → `200 { user }`, cookie `pigeon_session` set `HttpOnly; SameSite=Lax; Path=/` (`Secure` absent in dev test).
    - login nonexistent email / unverified / wrong pw → all three return identical `401 bad_credentials` (AC-2: assert same `status` + same `code`).
    - `GET /api/auth/me` with cookie → `200 { user }`; without → `401 unauthenticated`.
    - `POST /api/auth/logout` → `200`, cookie cleared, subsequent `me` → `401`.
    - sliding renewal: set `sessions.last_seen_at` to 5 days ago → `me` still `200` and `expires_at` advanced; set `created_at` to 91 days ago → `me` `401` (absolute cap); set `last_seen_at` to 31 days ago → `me` `401` (idle).
      Then `backend/src/auth/test/csrf.test.ts`: a `POST /api/auth/login` with `Origin: https://evil.test` → `403 cross_origin`; with `Origin` equal to `APP_BASE_URL`'s host → proceeds (200/401 on merits); with no `Origin` but a same-host `Referer` → proceeds; with neither → proceeds (Lax+non-GET is the real guard).
  - [ ] 7.2 CONFIRM RED: `pnpm test` — fails (middleware/session service absent).
  - [ ] 7.3 GREEN: `write-code` — `backend/src/auth/service.ts` add `createSession`, `revokeSession`, `revokeAllSessions`, `loadSession` (sliding renewal: refresh `last_seen_at`, extend `expires_at = now()+30d` capped by `created_at+90d`). `backend/src/auth/middleware.ts` `requireAuth(db)` (read cookie → hash → loadSession → `ctx.user` or `401`) and `csrfGuard()` (Origin/Referer host check vs `APP_BASE_URL`). `routes.ts` add `POST /api/auth/login` (constant-time: always run a decoy scrypt verify before the identical `bad_credentials`), `POST /api/auth/logout`, `GET /api/auth/me`. Mount `csrfGuard` on all mutating auth routes; `requireAuth` on `/me` and (later) protected routes. Cookie: `pigeon_session`; `Secure` only when `NODE_ENV==='production'`.
  - [ ] 7.4 CONFIRM GREEN: `pnpm test` — all session/login/csrf tests pass; Task 6's auto-login still works (refactored to use `createSession`).
  - [ ] 7.5 REFACTOR: decoy-hash constant named and commented "why"; middleware split from routes; `ctx.user` typed via Hono `Variables`.
  - [ ] 7.6 CHECK PHASE: `pnpm check`.

- [ ] 8.0 Password reset (FR-21..FR-23; AC-6)
  - [ ] 8.1 RED: `write-test` writes `backend/src/auth/test/reset.test.ts` (integration):
    - `POST /api/auth/password/reset-request` for a verified user → `202`, a `reset_password` token (1h TTL) exists, mock outbox has the reset email with `/reset-password?token=`; for a nonexistent email → still `202` (no enumeration); within 60s cooldown → `202` and no new token (assert outbox unchanged); a prior unconsumed reset token is voided when a new one is minted.
    - `POST /api/auth/password/reset` with a valid token + acceptable new pw → `200`, the user's `password_hash` changed (login with new pw succeeds, with old pw `401`); **all** the user's other sessions are revoked (a second pre-existing session's `me` → `401` — AC-5 reset branch); the token is single-use (second reset with it → `400`); an expired token → `400`; a weak new pw → `400`.
      One behavior per test.
  - [ ] 8.2 CONFIRM RED: `pnpm test` — fails (reset routes absent).
  - [ ] 8.3 GREEN: `write-code` — `service.ts` add `requestReset`, `resetPassword`; `routes.ts` add `POST /api/auth/password/reset-request` and `POST /api/auth/password/reset`. Reset runs in `withTx`: update `password_hash`, consume token, `revokeAllSessions`. Reset does NOT auto-login (client redirects to `/login`).
  - [ ] 8.4 CONFIRM GREEN: `pnpm test` — all reset tests pass.
  - [ ] 8.5 REFACTOR: token-TTL constants (verify 24h, reset 1h, resend cooldown 60s) named in one place.
  - [ ] 8.6 CHECK PHASE: `pnpm check`.

- [ ] 9.0 Invite CLI (`pnpm invite`) (FR-24, FR-25; AC-7)
  - [ ] 9.1 RED: `write-test` writes `backend/src/auth/test/invite-cli.test.ts` (integration): `main(['--count','3'])` inserts 3 `invites` rows with distinct `code_hash`, prints 3 distinct plaintext codes to stdout, exits 0; each printed code, when used at sign-up, is accepted exactly once (second use → `403 bad_invite`); `main(['--ttl','1s'])` + wait → the code is expired at sign-up → `403`. CLI reads validated config (so it opens the same `DATABASE_URL`); it does not start the HTTP server (assert no port bound — e.g. `main` returns before any `serve`).
  - [ ] 9.2 CONFIRM RED: `pnpm test` — fails (CLI absent).
  - [ ] 9.3 GREEN: `write-code` — `backend/src/auth/invite-cli.ts` (`main(args)` returning exit code; `tsx src/auth/invite-cli.ts` shim), `backend/package.json` `invite` script, root `package.json` `pnpm --filter @pigeon/backend invite`. Flags `--ttl <duration>` (e.g. `7d`; omit = no expiry), `--count <n>` (default 1). Uses `generateInviteCode()` + `hashToken()`-style hashing; prints codes to stdout only.
  - [ ] 9.4 CONFIRM GREEN: `pnpm test` — all pass; `pnpm invite --count 2` on the dev DB prints 2 codes (manual smoke).
  - [ ] 9.5 REFACTOR: arg parsing minimal and commented; no plaintext code logged.
  - [ ] 9.6 CHECK PHASE: `pnpm check`.

- [ ] 10.0 Frontend wiring — api client, dev proxy, pages, me-guard (FR-35..FR-40; AC-13)
  - [ ] 10.1 RED: `write-test` — frontend has no unit tests (per guidelines §2); the gate is `pnpm build` (Astro typecheck + build). Write the pages/components first (next step) then confirm the build is the failing "test": before wiring, `AuthForm.tsx` still calls the mock contract; the new pages don't exist; `astro check` + `pnpm build` should fail on missing imports / type errors once the new pages reference not-yet-added `auth.verifyEmail` etc.
  - [ ] 10.2 CONFIRM RED: `pnpm --filter @pigeon/frontend build` — fails (references to missing `auth.verifyEmail`/`requestReset`/`resetPassword`/`resendVerify`; missing pages).
  - [ ] 10.3 GREEN: `write-code` — (a) `frontend/src/lib/api.ts`: make `signup`'s `name` required; add `verifyEmail(token)`, `resendVerify(email)`, `requestReset(email)`, `resetPassword({token,newPassword})` (all `redirectOn401:false`); set `API_BASE` to `""` (same-origin) with `PUBLIC_API_BASE` override for staging. (b) `frontend/astro.config.mjs`: add `server.proxy: { '/api': 'http://localhost:8788' }` so dev is one origin. (c) Refactor `AuthForm.tsx` + `signup.astro`/`login.astro` to call the real `auth.signup`/`auth.login`, render `ApiError.message` inline, and `window.location.assign("/")` on success. (d) New `verify.astro` (reads `?token=`, calls `verifyEmail`, redirects to `/` or shows "link invalid/expired" + a resend link), `forgot-password.astro` (calls `requestReset`, shows "check your email"), `reset-password.astro` (reads `?token=`, collects new pw, calls `resetPassword`, redirects to `/login`). (e) Protected pages (`index.astro`) call `auth.me()` on mount; 401 → `/login` (already in `api.ts`).
  - [ ] 10.4 CONFIRM GREEN: `pnpm --filter @pigeon/frontend build` — green. Manual dev smoke (same origin via proxy): sign up with a minted invite → verification link logged by mock mail → click → land on `/` → logout → login → forgot-password → reset → login with new pw.
  - [ ] 10.5 REFACTOR: form state shared in `AuthForm`; consistent error styling; `import type` for `SessionUser` from `@pigeon/shared`.
  - [ ] 10.6 CHECK PHASE: `pnpm check` (lint + typecheck across all workspaces) + `pnpm build`.

- [ ] 11.0 `.env.example`, `docs/COMMANDS.md`, prod-required-keys smoke (FR-32; AC-10, AC-11)
  - [ ] 11.1 RED: `write-test` extends `config.test.ts` if not already: `NODE_ENV=production` with all four keys present parses (no throw). (Mostly already covered in Task 2; this is the positive-case gap.)
  - [ ] 11.2 CONFIRM RED: if a gap exists, it fails; else mark as already-green and move on (do not fabricate a failure).
  - [ ] 11.3 GREEN: `write-code` — add the four new keys to `.env.example` (commented, with the mock-fallback note for `RESEND_API_KEY`); update `docs/COMMANDS.md` with `pnpm invite` and the mock-mail dev story (links logged to stdout at `info`).
  - [ ] 11.4 CONFIRM GREEN: `pnpm test backend/test/config.test.ts` — all pass.
  - [ ] 11.5 REFACTOR: `.env.example` ordering matches the schema; no secrets present.
  - [ ] 11.6 CHECK PHASE: `pnpm check`.

- [ ] 12.0 Final: full suite + lint + typecheck + AC sweep (all ACs)
  - [ ] 12.1 `pnpm check:all` — lint + typecheck + all integration tests green (embedded Postgres, mock mail, faked Resend). If anything fails, STOP and note which PRD decision could have prevented the block.
  - [ ] 12.2 AC sweep (verify against the live dev stack): AC-1 (signup→verify→auto-login), AC-2 (identical bad_credentials), AC-3 (no unverified leak on login), AC-4 (re-signup re-issues / verified 409), AC-5 (sliding/absolute + reset revokes all sessions), AC-6 (reset flow single-use/1h), AC-7 (`pnpm invite` codes single-use + expiry), AC-8 (`requireAuth` /me 200 vs 401), AC-9 (foreign Origin → 403, no GET mutations), AC-10 (prod missing-key crash; dev mock fallback), AC-11 (no plaintext secrets in `.env.example`/logs/DB — only `*_hash` columns populated), AC-12 (green suite + build), AC-13 (frontend auth screens end-to-end on one origin).
  - [ ] 12.3 If the dev same-origin proxy (OQ3) needed a different mechanism than the Vite proxy, note it here for the PRD's record.

- [ ] Commit message: `feat(auth): add invite-gated sign-up, email verification, sessions, login/logout, and password reset with a Resend mail module`

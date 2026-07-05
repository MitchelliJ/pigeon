OQ4: reui# PRD — 2. Authentication & User Accounts

> Provide sign-up, login, and session management that every other resource
> attaches to. **Minimal scope:** only what's needed to get a user onto the app
> and authenticated — sign-up (with email verification), login, logout, password
> reset, and the session revocation that reset implies. Broader account/session
> management (list/revoke sessions, change password, change email, account
> deletion) is deferred to **Capability 14**.

---

## 1. Introduction / Overview

This is the second walking-skeleton feature. It mounts onto the Feature 1
baseline (Postgres, migrations, validated config, embedded-Postgres test
harness) and delivers the **identity layer** every later feature attaches to:
inboxes, channels, digests, billing, and quotas all key off the `users` row and
the `requireAuth` middleware introduced here.

The deliverable is a complete, dependency-light auth loop:

1. **Invite-gated sign-up.** An operator mints a single-use invite code via a
   CLI command. A visitor provides the code + email + password; we create a
   `pending` (unverified) user and email a verification link via **Resend**.
2. **Email verification.** Clicking the link marks the account verified, voids
   the token, and starts a session (auto-login → dashboard).
3. **Login / logout.** Email + password against a `users` row; an opaque,
   hashed-at-rest session token delivered as an `httpOnly` `SameSite=Lax`
   cookie with a **30-day sliding idle + 90-day absolute** lifetime.
4. **Password reset.** "Forgot password" → email a single-use, short-TTL reset
   token → set a new password → revoke **all** of the user's other sessions.
5. **`requireAuth` middleware.** Every resource route (added from Feature 3 on)
   is guarded; the authenticated `User` is attached to the request context.
   Constant-time behaviour on unknown accounts — no user enumeration.

**Problem solved:** today there is no identity. The mock frontend has
`login.astro`/`signup.astro`/`AuthForm.tsx` and `api.ts` already declares an
`/api/auth/*` contract (`signup|login|logout|me`), but the backend has no
`users`/`sessions` tables, no password hashing, no cookie, no mail. Feature 2
makes that contract real and gives every subsequent feature a user to hang off.

**What this is _not_:** not the full account/session-management surface. No
"list my sessions," no "change password while logged in," no "change email," no
self-service GDPR erasure — those are Capability 14 (added to the spec by this
PRD). No brute-force rate limiting — that's Capability 13 (also added by this
PRD). No OAuth login — Capability 11.

---

## 2. User Stories

- **As a visitor**, I want to sign up using an invite code, my email, and a
  password, so that I can create my Pigeon account.
- **As a visitor**, I want to receive a verification email with a link, so that
  I can prove the address is mine before I can log in.
- **As a visitor**, I want clicking the verification link to verify my account
  and log me in automatically, so that I land on the dashboard with one click.
- **As a visitor who typo'd my email at sign-up**, I want signing up again with
  the same (still-unverified) email to re-issue a fresh verification link rather
  than tell me "email already taken," so that a fat-fingered first attempt
  self-heals.
- **As a user**, I want to log in with email + password and stay logged in
  across restarts for up to 30 days of activity, so that I don't re-authenticate
  constantly.
- **As a user**, I want to log out, so that my session ends on this device.
- **As a user who forgot my password**, I want to request a reset email, click
  the link, and set a new password, so that I can get back in without support.
- **As a user who reset my password**, I want all my other sessions revoked, so
  that a compromised password doesn't keep an attacker logged in.
- **As an operator**, I want a CLI command to mint single-use invite codes, so
  that I can control who can sign up before public registration opens.
- **As a developer**, I want a `requireAuth` middleware that attaches the
  current `User` to the request context, so that every resource route I add
  (mailboxes, channels, billing…) just reads `ctx.user`.
- **As a developer**, I want the auth mail path (Resend) behind an interface
  with a mock fallback, so that the app is demoable and testable without a live
  Resend key.
- **As a developer**, I want integration tests that boot embedded Postgres,
  exercise the real SQL and the real cookie/session flow, and fake Resend behind
  its interface, so that auth bugs surface locally before CI.

---

## 3. Functional Requirements

### 3.1 Backend module: `backend/src/auth/`

A self-contained folder: routes, service logic, SQL (co-located with the
module), and types. Two entry points (`server.ts`, `worker.ts`) import from it
as needed (only `server.ts` mounts auth routes; the worker does not serve HTTP).

#### 3.1.1 Database tables (new migration `0003_users_sessions.sql`)

- **`users`**
  - `id UUID PRIMARY KEY DEFAULT gen_random_uuid()`
  - `email CITEXT UNIQUE NOT NULL` (case-insensitive uniqueness; if `citext`
    extension isn't enabled, add `CREATE EXTENSION IF NOT EXISTS citext` in this
    migration).
  - `password_hash TEXT NOT NULL` — scrypt output encoded as
    `scrypt:N:r:p:saltHex:hashHex` (params stored per-hash, per coding
    guidelines §2).
  - `name TEXT` — optional display name (the `SessionUser.name` the frontend
    expects).
  - `tier TEXT NOT NULL DEFAULT 'free'` — placeholder; Feature 9 owns real
    tiers. Default `'free'` so `SessionUser.tier` is always populated.
  - `email_verified_at TIMESTAMPTZ` — `NULL` until verification.
  - `created_at TIMESTAMPTZ NOT NULL DEFAULT now()`
  - `updated_at TIMESTAMPTZ NOT NULL DEFAULT now()`
- **`sessions`**
  - `id UUID PRIMARY KEY DEFAULT gen_random_uuid()`
  - `user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE`
  - `token_hash TEXT NOT NULL` — SHA-256 of the opaque token (we hash at rest).
  - `created_at TIMESTAMPTZ NOT NULL DEFAULT now()` — drives the 90d absolute
    cap.
  - `last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()` — drives the 30d sliding
    idle.
  - `expires_at TIMESTAMPTZ NOT NULL` — precomputed `min(created_at+90d,
now()+30d)`, checked by the middleware.
  - `revoked_at TIMESTAMPTZ` — set on logout / "revoke all others."
  - `UNIQUE (token_hash)` and an index on `(user_id)` for "revoke all."
- **`auth_tokens`** — single table for both verification and reset tokens
  (discriminated by `kind`).
  - `id UUID PRIMARY KEY DEFAULT gen_random_uuid()`
  - `user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE`
  - `kind TEXT NOT NULL CHECK (kind IN ('verify_email','reset_password'))`
  - `token_hash TEXT NOT NULL` — SHA-256 of the opaque token.
  - `expires_at TIMESTAMPTZ NOT NULL`
  - `consumed_at TIMESTAMPTZ` — set on use; single-use enforced.
  - `UNIQUE (token_hash)`.
- **`invites`**
  - `id UUID PRIMARY KEY DEFAULT gen_random_uuid()`
  - `code_hash TEXT NOT NULL UNIQUE` — SHA-256 of the invite code (we never
    store the plaintext code).
  - `created_at TIMESTAMPTZ NOT NULL DEFAULT now()`
  - `expires_at TIMESTAMPTZ` — optional TTL.
  - `consumed_at TIMESTAMPTZ` — set when a sign-up uses it.
  - `created_by_user_id UUID REFERENCES users(id)` — `NULL` for CLI-minted
    invites (the operator isn't a user); populated later when an admin UI mints
    them.

> All token values (session, verify, reset, invite) are **opaque random
> bytes** generated with `node:crypto.randomBytes(32)`, hex/base64url-encoded,
> and stored **only as their SHA-256 hash**. The plaintext appears solely in
> the HTTP-only cookie / the emailed link / the CLI's stdout — never in the DB
> or logs.

#### 3.1.2 Password hashing

- **FR-A.** Passwords hashed with **scrypt** (`node:crypto`), parameters
  `N=2^15, r=8, p=1`, salt `randomBytes(16)`, stored per-hash as
  `scrypt:N:r:p:saltHex:hashHex`. The `auth/` module owns a `hashPassword(pw)`
  and `verifyPassword(pw, encoded)` helper.
- **FR-B.** Password **strength**: minimum **12 characters**. No complexity
  rules. Reject the top ~100 most common passwords from a small committed
  denylist (`backend/src/auth/common-passwords.json`, ~100 entries, offline, no
  network). Denylist match is case-insensitive.
- **FR-C.** **Constant-time** verification on the hot path: whether or not the
  user exists, the handler always runs a dummy scrypt verify against a fixed
  decoy hash before returning the same-shaped error response in the same
  ballpark of time, so login/reset timing can't distinguish "no such user" from
  "wrong password." (Resend verification/reset emails are only sent for real
  users — this is the one place user existence is observable; that's accepted
  and documented, since reset-by-email requires a destination.)

#### 3.1.3 Sign-up flow (`POST /api/auth/signup`)

- **FR-1.** Request body: `{ inviteCode, email, password, name? }`.
- **FR-2.** Validate: email is a plausible email (Zod); password meets FR-B;
  `name` (if present) is ≤ 200 chars and stripped.
- **FR-3.** **Invite check:** hash `inviteCode`, look up an `invites` row by
  `code_hash` where `consumed_at IS NULL AND (expires_at IS NULL OR expires_at >
now())`. If none → `403` `{ error: "invalid invite code", code: "bad_invite" }`.
- **FR-4.** **Email collision rule:**
  - If a `users` row exists with this email **and** `email_verified_at IS NULL`
    → **reuse** it: rotate its `password_hash` to the new password, update
    `name` if provided, void any existing `verify_email` tokens for that user,
    mint a fresh `verify_email` token, and email the link. (The "fat-fingered
    first attempt self-heals" story.) The invite is **not** consumed yet — it's
    consumed only when the account verifies (so a typo'd email doesn't burn an
    invite).
  - If a `users` row exists and `email_verified_at IS NOT NULL` → `409`
    `{ error: "email already registered", code: "email_taken" }` (this reveals
    that the email is registered; accepted — it's a registration collision, not
    a login probe).
  - Otherwise → `INSERT INTO users` (unverified), hash password, mint a
    `verify_email` token.
- **FR-5.** **Send verification email** via the mail module (§3.2) with a link
  to `${APP_BASE_URL}/verify?token=...`. Do **not** consume the invite yet.
- **FR-6.** Response: `202` `{ status: "verify_email_sent" }`. The account
  cannot log in until verified (login returns `403` `{ code: "unverified" }`).
- **FR-7.** All of the above happens in a single DB transaction (user upsert +
  token mint); the email send is **after** commit (never send then fail-to-persist). If the mail send fails, the user still exists unverified and can
  request a resend — the response stays `202` (we don't leak transport errors to
  the client, but log them).

#### 3.1.4 Resend verification (`POST /api/auth/verify/resend`)

- **FR-8.** Body: `{ email }`. Always returns `202` (do not reveal whether the
  email exists). For a real unverified user, mint a new `verify_email` token
  only if the most recent one is older than a **60-second cooldown**; otherwise
  re-send is a no-op that still returns `202`. Void prior pending tokens for
  that user on mint.

#### 3.1.5 Verify email (`POST /api/auth/verify`)

- **FR-9.** Body: `{ token }`. Hash the token, look up an unconsumed
  `auth_tokens` row of `kind='verify_email'` where `expires_at > now()`. If
  none → `400` `{ code: "invalid_or_expired_token" }`.
- **FR-10.** In a transaction: set `users.email_verified_at = now()`, set
  `auth_tokens.consumed_at = now()` (single-use), and **consume the invite**
  that was presented at sign-up — track which invite by storing
  `pending_invite_code_hash` on the user row during sign-up (add a column) so
  verify knows which `invites` row to mark `consumed_at = now()`. (This is why
  the invite is consumed on verify, not on sign-up.)
- **FR-11.** Create the first session (§3.1.7), set the cookie, respond `200
{ user: SessionUser }` — auto-login. The frontend redirects to `/`.
- **FR-12.** A token is single-use: a second `POST /api/auth/verify` with the
  same token returns `400 invalid_or_expired_token` (consumed_at is set).

#### 3.1.6 Login (`POST /api/auth/login`)

- **FR-13.** Body: `{ email, password }`. Look up the user by `email`
  (case-insensitive via `citext`). Run FR-C constant-time verification. If the
  user is missing, unverified, or the password is wrong → `401`
  `{ error: "invalid credentials", code: "bad_credentials" }` (same response for
  all three, after the decoy scrypt).
- **FR-14.** On success: create a session (§3.1.7), set the cookie, respond
  `200 { user: SessionUser }`.
- **FR-15.** No rate limiting in Feature 2 (Capability 13).

#### 3.1.7 Session lifecycle

- **FR-16.** **Creation:** generate `randomBytes(32)` (base64url) as the token;
  store `sha256(token)` as `token_hash`; set `created_at = last_seen_at = now()`,
  `expires_at = min(created_at + 90 days, now() + 30 days)`. Return the token
  only via the cookie.
- **FR-17.** **Cookie:** `pigeon_session=<token>; HttpOnly; SameSite=Lax;
Path=/; Secure` (`Secure` always set in production; in dev over HTTP the
  `Secure` flag is omitted so localhost works — driven by `NODE_ENV`). Max-Age
  not set on the cookie (the DB `expires_at` is the source of truth, so sliding
  renewal doesn't require rewriting the cookie).
- **FR-18.** **`requireAuth` middleware:** on every protected route, read the
  cookie, hash it, look up a `sessions` row where `revoked_at IS NULL AND
expires_at > now()`. If found and the user is verified: refresh
  `last_seen_at = now()` and, if `now() + 30d < created_at + 90d`, extend
  `expires_at = now() + 30d` (the sliding renewal, capped by the 90d absolute);
  attach `ctx.user = { id, email, name, tier }`; continue. Otherwise: `401
{ code: "unauthenticated" }`.
- **FR-19.** **Logout (`POST /api/auth/logout`):** set `revoked_at = now()` on
  the current session row; clear the cookie (`Max-Age=0`). Respond `200 { ok:
true }`.
- **FR-20.** **`GET /api/auth/me`:** behind `requireAuth`; responds `200 { user:
SessionUser }`. 401 otherwise (the frontend `api.ts` already uses this with
  `redirectOn401: false`).

#### 3.1.8 Password reset

- **FR-21.** **Request (`POST /api/auth/password/reset-request`):** body
  `{ email }`. For a real verified user, mint a `reset_password` token with a
  **1-hour TTL**, voiding any existing unconsumed `reset_password` tokens for
  that user (single outstanding reset). Email a link to
  `${APP_BASE_URL}/reset-password?token=...`. Always responds `202` (no user
  enumeration). Apply a **60-second cooldown** between resets for the same email
  (no-op-but-still-202 within the cooldown).
- **FR-22.** **Confirm (`POST /api/auth/password/reset`):** body `{ token,
newPassword }`. Hash the token, find an unconsumed `reset_password` row where
  `expires_at > now()`. If none → `400 { code: "invalid_or_expired_token" }`.
  Validate `newPassword` against FR-B. In a transaction: update the user's
  `password_hash`, set the token `consumed_at = now()`, and **revoke all the
  user's sessions** (`UPDATE sessions SET revoked_at = now() WHERE user_id = ?
AND revoked_at IS NULL`). Respond `200 { ok: true }` — the user must log in
  fresh (deliberately no auto-session here, unlike verify).
- **FR-23.** After reset, the reset token is single-use (second use → `400`).

#### 3.1.9 Invite minting (CLI)

- **FR-24.** A new CLI entrypoint `backend/src/auth/invite-cli.ts`, exposed as
  `pnpm invite` (root) / `pnpm --filter @pigeon/backend invite`. Flags:
  `--ttl <duration>` (optional, e.g. `7d`; omit for no expiry), `--count <n>`
  (default 1). Generates `randomBytes(9)` → base32 (≈15 chars, human-typable),
  hashes it, inserts an `invites` row, and **prints the plaintext code(s)** to
  stdout (one per line) — never logged elsewhere.
- **FR-25.** The CLI reads validated config (so it opens the same `DATABASE_URL`
  the app uses) and exits 0 / non-zero; it does not start the HTTP server.

### 3.2 Backend module: `backend/src/mail/`

A thin outbound-email module behind an interface, Resend as the real provider,
a mock fallback for dev/test (per coding guidelines §1 "mock/sandbox fallback
so the app is demoable without keys").

- **FR-26.** `MailSender` interface: `send({ to, subject, html, text }) =>
Promise<{ ok: true } | { ok: false, reason: string }>`. Choosing the provider
  is a config decision at startup.
- **FR-27.** **Resend provider** (`backend/src/mail/resend.ts`) using the
  `resend` npm package, sending from `MAIL_FROM`. Surfaces transport failures as
  `{ ok: false, reason }`; the caller (auth) logs the reason and proceeds (it
  never throws into the request path — FR-7/FR-21 already return `202`).
- **FR-28.** **Mock provider** (`backend/src/mail/mock.ts`): logs the email
  (subject + a clickable link to stdout at `LOG_LEVEL=info`) and pushes it onto
  an in-process ring buffer exposing `mockMail.outbox()` for tests. Used when
  `RESEND_API_KEY` is absent **and** `NODE_ENV !== 'production'` (production
  without a key is a startup config error — see FR-31).
- **FR-29.** Templates (`backend/src/mail/templates.ts`) for the two emails:
  verification and password-reset. Plain-text + minimal HTML, link rendered
  with `${APP_BASE_URL}/verify?token=...` / `.../reset-password?token=...`.
  Tokens are in the URL fragment path, not stored anywhere plaintext.

### 3.3 Config additions (`backend/src/config/`)

- **FR-30.** Extend the Zod schema (Feature 1's config) with:
  - `APP_BASE_URL` — **required**, the public origin for verification/reset
    links (e.g. `https://app.pigeon.email`). Validated as a URL.
  - `MAIL_FROM` — **required in production**, e.g. `Pigeon <noreply@pigeon.email>`.
  - `RESEND_API_KEY` — optional string. **Required in `NODE_ENV=production`**
    (FR-31); when absent in `development`/`test`, the mock provider is used.
  - `SIGNUP_OPEN` — boolean, default `false`. When `true`, sign-up **ignores**
    the invite code (open registration, Capability-for-later flip). Feature 2
    ships the flag at `false` (invite-gated); the open path is the same code
    with the invite check skipped — ready to flip.
- **FR-31.** Startup validation: in `production`, both `MAIL_FROM` and
  `RESEND_API_KEY` are required; missing either crashes the process before
  binding (consistent with Feature 1's fail-fast config rule).
- **FR-32.** `.env.example` gains the four new keys (commented, with the
  mock-fallback note for `RESEND_API_KEY`). `.env.old` is left untouched.

### 3.4 CSRF & cookie hygiene

- **FR-33.** All mutating auth routes are **non-GET** (`POST`), so
  `SameSite=Lax` blocks cross-site cookie carriage. Additionally, the
  `requireAuth` middleware and every mutating handler reject requests whose
  `Origin` (or `Referer` if `Origin` absent) is present and **not** equal to
  `APP_BASE_URL`'s host, returning `403 { code: "cross_origin" }`. Requests
  with neither header (rare, some CLI/proxy) are allowed — Lax + non-GET is the
  real guard; this is defense in depth.
- **FR-34.** Cookies are never marked `Secure` over plain HTTP in dev
  (`NODE_ENV=development`), so localhost auth works; always `Secure` in
  production.

### 3.5 Frontend (`frontend/`)

- **FR-35.** Replace the mock wiring in `src/pages/signup.astro`,
  `src/pages/login.astro` with real Solid-island forms (the existing
  `AuthForm.tsx` is refactored or replaced) that call the `auth.*` API client
  in `src/lib/api.ts` (already declared). On success: `window.location.assign("/")`.
  On error: render the `ApiError.message` inline.
- **FR-36.** New `src/pages/verify.astro` — reads `?token=` from the query, on
  mount calls a new `auth.verifyEmail(token)` client method (`POST /api/auth/verify`)
  and either redirects to `/` (success) or shows "link invalid or expired" with
  a link to request a resend.
- **FR-37.** New `src/pages/forgot-password.astro` and `src/pages/reset-password.astro`:
  the former calls `auth.requestReset({ email })` and shows "check your email";
  the latter reads `?token=`, collects a new password, calls
  `auth.resetPassword({ token, newPassword })`, then redirects to `/login` on
  success.
- **FR-38.** Extend `src/lib/api.ts`'s `auth` object with `verifyEmail`,
  `requestReset`, `resetPassword`, and `resendVerify` — all using
  `redirectOn401: false`.
- **FR-39.** A `requireAuth`-style **client** guard: protected pages (e.g.
  `index.astro`) call `auth.me()` on mount; 401 → `/login` (already handled in
  `api.ts`). Public pages (signup/login/verify/forgot/reset) do not.
- **FR-40.** No frontend unit tests (per coding guidelines §2: "Frontend
  components are not unit-tested unless they carry real logic"). The Astro
  `pnpm build` is the frontend gate.

### 3.6 Tests (`backend/src/auth/test/`, `backend/src/mail/test/`)

- **FR-41.** Integration tests boot the embedded-Postgres harness (Feature 1)
  and apply migrations through the runner. Tests cover:
  - Sign-up with a valid invite → unverified user created → mock outbox has the
    verification email.
  - Sign-up with a consumed/expired/missing invite → `403 bad_invite`; invite is
    **not** consumed by an unverified-then-typo flow until verify.
  - Re-signup with the same unverified email → re-issues a fresh token, old
    tokens voided.
  - Verify → `email_verified_at` set, token consumed (second use `400`), invite
    consumed, session cookie set (`auth.me()` returns the user).
  - Login before verify → `401 bad_credentials` (same shape as wrong password).
  - Login after verify → cookie set, `/api/auth/me` works, logout revokes the
    session (subsequent `me` → `401`).
  - Sliding renewal: a session whose `last_seen_at` is 5 days old is still
    valid and `expires_at` advances on use; a session past 90d absolute is
    rejected; a session idle > 30d is rejected.
  - Reset-request for a real user mints a 1h token; reset with it changes the
    password and revokes all other sessions (an existing second session is
    `401` after reset); reset token is single-use.
  - Constant-time-ish: login with a nonexistent email returns the same error
    shape/code as a wrong password (assertion on the response, not timing).
  - CSRF: a `POST` with a foreign `Origin` is `403 cross_origin`.
- **FR-42.** `mail/test` covers the mock outbox and the Resend provider behind
  the interface using a faked fetch (no network). The Resend provider is not
  called with a real key in CI.

---

## 4. Technical Requirements

- **Language/runtime:** TypeScript, ESM, Node 22, `tsx`. Strict,
  `noUncheckedIndexedAccess`. `import type` for shared types.
- **No new workspaces:** auth and mail are folders under `backend/src/`. No
  4th package. Shared auth types (`SessionUser`, request/response shapes) move
  to `shared/src/` so the frontend imports them type-only (matches the existing
  `SessionUser` already exported from `api.ts` — promote it to `@pigeon/shared`).
- **Crypto:** `node:crypto` only — `scrypt` for passwords, `randomBytes` for
  all tokens/codes, `createHash('sha256')` for at-rest token/invite hashing. No
  new crypto dependency.
- **Resend:** the `resend` npm package, added to `backend/`. Supply-chain guard
  (`minimumReleaseAge: 1440`) applies; pin a released version. Resend calls go
  through the `MailSender` interface; the mock provider is the default in
  `development`/`test`.
- **DB:** hand-written SQL, co-located with `auth/`. Migration
  `0003_users_sessions.sql` adds `users`, `sessions`, `auth_tokens`, `invites`
  and `CREATE EXTENSION IF NOT EXISTS citext`. Forward-only, single transaction
  per file (Feature 1's runner).
- **Sessions, not JWTs:** opaque tokens, hashed at rest, `httpOnly` cookie, 30d
  sliding / 90d absolute, DB-revocable. No JWT library.
- **`requireAuth` middleware:** a Hono middleware that reads the cookie, loads
  the session+user, attaches `ctx.user`, and returns `401` otherwise. Every
  non-auth route from Feature 3 onward uses it.
- **Constant-time login:** always run a scrypt verify (real or decoy) before
  returning the identical `bad_credentials` response for missing-user /
  unverified / wrong-password. Document the one observable leak (reset/verify
  emails are only sent to real addresses) in a code comment.
- **CSRF:** `SameSite=Lax` + non-GET mutations + `Origin`/`Referer` host check
  against `APP_BASE_URL`. No CSRF-token library.
- **Same-origin in dev:** because `SameSite=Lax` cookies don't travel
  cross-origin, the dev setup must serve the frontend and API on one origin.
  Either (a) the Astro dev server proxies `/api/*` → `localhost:8788` (Vite
  proxy in `astro.config`), or (b) the backend serves the built frontend in dev.
  Option (a) is recommended; `API_BASE` then becomes `""` (same-origin) and
  `PUBLIC_API_BASE` is only needed for cross-origin staging. This unblocks the
  `credentials: "include"` + `SameSite=Lax` combination.
- **Config validation:** Zod, parsed once at startup in `config/`. New keys per
  FR-30. Production without `MAIL_FROM`/`RESEND_API_KEY` crashes before bind.
- **Module-doc convention:** `auth/` and `mail/` each start with a block comment
  (what + why), per coding guidelines §3.
- **Conventional Commits:** PRs use `feat(auth): ...`, `feat(mail): ...`.
- **No rate limiting, no session-listing UI, no change-email, no account
  deletion** in this feature (Capabilities 13 & 14).

---

## 5. Acceptance Criteria

1. **AC-1.** A visitor with a valid invite code can sign up, receive a
   verification email (mock outbox in dev, real Resend in prod), click the
   link, and land on `/` authenticated — covered by an integration test that
   asserts `email_verified_at` is set, the invite is consumed, and `auth.me()`
   returns the user.
2. **AC-2.** Login is **constant-time-ish**: a nonexistent email, an unverified
   account, and a wrong password all return the identical `401 bad_credentials`
   response shape; only a correct, verified login returns `200` and sets the
   cookie. (Integration test asserts the shape/code, not timing.)
3. **AC-3.** A signed-up-but-unverified account **cannot** log in (`401
bad_credentials`, same as wrong password — no "unverified" leak on the login
   endpoint). The unverified state is surfaced only at sign-up/verify.
4. **AC-4.** Re-signup with the same still-unverified email does **not** error;
   it rotates the password, voids old verify tokens, and emails a fresh link.
   Re-signup with a verified email returns `409 email_taken`.
5. **AC-5.** Sessions honor 30d-sliding/90d-absolute: a 5-day-idle session is
   valid and its `expires_at` advances on use; a >90-day-old session is rejected
   even if "active"; a >30-day-idle session is rejected. Logout revokes the
   current session; password reset revokes **all** the user's sessions
   (integration test asserts a second device's session is `401` after reset).
6. **AC-6.** Password reset: request → email → click → set new password → log
   in with the new password. Reset tokens are single-use, 1h TTL. Request
   endpoint always returns `202` (no user enumeration). 60s cooldown on
   resend/reset-request holds.
7. **AC-7.** `pnpm invite --count 3` prints three single-use codes to stdout;
   each works exactly once at sign-up (a second sign-up with the same consumed
   code → `403 bad_invite`); an expired invite (`--ttl 1s` + wait) → `403`.
8. **AC-8.** `requireAuth` is in place: `GET /api/auth/me` returns `200` with
   the `SessionUser` when authenticated and `401` otherwise. A placeholder
   protected route (or the existing `/api/dashboard`) returns `401` without the
   cookie.
9. **AC-9.** CSRF: any `POST /api/auth/*` with a foreign `Origin` returns `403
cross_origin`; same-origin (or no header) proceeds normally. All mutating
   auth routes are `POST` (no GET mutations).
10. **AC-10.** Config: starting the API in `NODE_ENV=production` without
    `MAIL_FROM` or `RESEND_API_KEY` (or `APP_BASE_URL`) exits non-zero before
    binding, naming the missing variable. In `development` with no
    `RESEND_API_KEY`, the mock mail provider is used and the app starts.
11. **AC-11.** `.env.example` documents the four new keys
    (`APP_BASE_URL`, `MAIL_FROM`, `RESEND_API_KEY`, `SIGNUP_OPEN`); no plaintext
    secrets appear in `.env.example` or logs; token/invite plaintext never
    appears in the DB (assert: only `*_hash` columns are populated).
12. **AC-12.** `pnpm check:all` is green, including the new auth/mail
    integration tests booting embedded Postgres and faking Resend behind the
    `MailSender` interface (no network in CI). `pnpm build` (frontend) is green.
13. **AC-13.** The frontend auth screens (signup, login, verify,
    forgot-password, reset-password) work end-to-end against the real backend
    on one origin (dev proxy), and a 401 on a protected page redirects to
    `/login`.

---

## 6. Open Questions

- **OQ1.** The `pending_invite_code_hash` column on `users` (FR-10) is one way
  to consume the invite at verify-time. An alternative is to consume the invite
  at sign-up and **refund** it (un-consume) if the user never verifies — but
  "refund" is stateful and messy. The proposed column is simpler. Confirm the
  column approach is acceptable, or prefer consume-at-signup with no refund
  (an unverified sign-up burns the invite)?
- **OQ2.** Email sender domain: Resend requires a verified sending domain. Is
  `MAIL_FROM` going to live on a domain you already own + have verified in
  Resend (e.g. `pigeon.email`), and should `APP_BASE_URL` share that domain?
  This is operational, not code, but the verification/reset links' host depends
  on it.
- **OQ3.** The dev same-origin story (Technical Requirements: Astro Vite proxy
  vs. backend-serves-frontend) — the recommended proxy approach is the default,
  but if the existing frontend dev setup has constraints, the exact mechanism is
  a create-tasks decision.
- **OQ4.** `name` is optional at sign-up. The dashboard `Hero`/`SessionUser`
  expects a `name`. Should we prompt for a name on first verified login if it
  was omitted, or just default to the email local-part? (Minor; leaning
  default-to-local-part, prompt later in Capability 14.)

---

## 7. Non-Goals (Out of Scope)

- **No rate limiting / brute-force protection** on login, reset, or resend
  endpoints — Capability 13.
- **No "list/revoke active sessions," no "logout everywhere" as a standalone
  action, no "change password while logged in," no "change email," no
  self-service account deletion** — Capability 14. (Password reset revokes all
  sessions as a security side-effect, but there's no UI to list or selectively
  revoke sessions.)
- **No OAuth / social login** (Gmail/Microsoft as a _login_ provider) —
  Capability 11. (OAuth there is for _inbox_ connectors, not auth.)
- **No MFA / 2FA.** Deferred indefinitely; not in the spec.
- **No public/open registration yet.** `SIGNUP_OPEN` ships at `false`; flipping
  it is a later operational decision. The open path exists but is gated.
- **No admin UI for invites.** Invites are CLI-only (`pnpm invite`).
- **No email-change flow.** Users verify once at sign-up; changing the address
  is Capability 14.
- **No session listing UI, no device tracking beyond `last_seen_at`.** We
  record `last_seen_at` but don't yet render it.
- **No audit log.** Auth events aren't written to a separate audit table;
  stdout logs only. (Capability 13 may revisit.)
- **No new external stateful services.** Resend is a stateless third-party API
  call; no Redis, no queue (the queue is Feature 5).
- **No changes to the worker.** Auth is request-path only; the worker is
  untouched in this feature.

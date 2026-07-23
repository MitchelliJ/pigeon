# PRD — Account Management (self-service password, email & deletion)

> Feature 16 (partial) from the project synopsis. This PRD covers **change
> password (while logged in)**, **change email (with verification)**, and
> **self-service account/data deletion (GDPR erasure)**. The other Feature 16
> capabilities — "log out everywhere" and "list/revoke active sessions" — are
> explicitly deferred to a later PRD (see Non-Goals).

---

## 1. Problem statement

A signed-in Pigeon user today has no way to manage their own account. They
cannot change their password without going through the logged-out
"forgot password" email flow, they cannot change their email address at all
(the field is `readOnly` in `SettingsDialog`), and they cannot delete their
account and data. The last one is a GDPR obligation ("erasure… designed in from
feature 1", synopsis §6) that the product currently cannot honour
self-service. The frontend already _assumes_ a deletion endpoint exists
(`PrivacyPanel.tsx` calls `POST /api/privacy/erase`), but no backend route
backs it.

---

## 2. Known facts

- **The database is already cascade-safe for deletion.** Every user-owned table
  (`sessions`, `auth_tokens`, `mailboxes`, `mailbox_messages`, `messages`,
  `channels`, `delivery_settings`, `delivery_attempts`, `digest_items`) has
  `ON DELETE CASCADE` back to `users.id`; `invites.created_by_user_id` is
  `ON DELETE SET NULL` (migration `0008`). A single `DELETE FROM users WHERE
id = …` erases everything owned by that user.
- **`jobs` has no FK to any of this.** The queue links to work only via a
  mailbox/message/attempt id inside a JSONB payload, so a raw cascade delete
  leaves orphaned `sync_mailbox` / `summarize_classify` / `deliver_channel`
  jobs. Each handler already `throw`s "…not found" when its target row is gone
  (`backend/src/queue/handlers/*.ts`), so orphaned jobs self-resolve via the
  normal retry→permanent-fail path. **This is already the accepted behaviour
  every time a user disconnects a single inbox today** (`removeMailbox` is just
  `DELETE FROM mailboxes` and relies on the same cascade + the
  `mailbox_messages_delete_orphan` trigger).
- **Job resolution is fast.** Backoff is 1 minute after the first failure, then
  5 minutes; `max_attempts` defaults to 3 (`backend/src/queue/store.ts`). Any
  job for a user reaches a terminal state within ~10–15 minutes worst case.
- **Schedulers all tick every 60s.** `worker.ts` registers each scheduler as a
  `setInterval` on `SCHEDULER_INTERVAL_MS` (default `60000`). Sync-due selection
  is per-mailbox; daily/quiet digests are per-user (channel + delivery_settings).
- **Existing auth machinery is reusable.** `auth_tokens` already stores hashed,
  single-use, TTL'd tokens discriminated by `kind` (currently `verify_email` /
  `reset_password`); `voidOutstandingAndMint`, `generateToken`/`hashToken`,
  `hashPassword`/`verifyPassword`/`isAcceptablePassword`, `revokeSession`/
  `revokeAllSessions`, the `MailSender` interface + templates, `csrfGuard`,
  `requireAuth`, `bodyLimit`, and `rateLimit` all exist.
- **Password change does not exist authenticated.** Only the logged-out reset
  flow (`/api/auth/password/reset-request` + `/reset`) exists today.
- **Billing does not exist yet** (Feature 12 unbuilt — no backend `billing`
  module, no Mollie subscription rows). Deletion has no live subscription to
  cancel. The frontend `api.ts` `billing`/`privacy.export`/`privacy.consents`
  clients are speculative and out of scope here.
- **Frontend already speaks the deletion contract**: `POST /api/privacy/erase`
  with body `{ password, confirm: "delete my account" }`, expecting `{ ok: true }`,
  then redirects to `/login`. `PrivacyPanel` also gates on the user typing the
  exact string `delete my account`.

## 3. Unknowns

- None blocking. Assumption: confirming an email change does **not** invalidate
  sessions (the `users.id` is unchanged; only the login identifier moves).
- Assumption: the "Cancel deletion" affordance and pending-deletion banner are
  new UI in `PrivacyPanel` (design left to implementation, copy in §9).

---

## 4. Proposed solution

Three independent, self-contained capabilities, all mounted behind
`requireAuth` + `csrfGuard` + `bodyLimit` and (where credential-guessing is a
risk) `rateLimit`, following the existing auth-route patterns. New backend home:
extend `backend/src/profile/` (already the authenticated-settings module) rather
than pre-creating a `privacy` module — but keep the frontend's existing
`/api/privacy/erase` path.

### 4.1 Change password (authenticated)

- `POST /api/settings/password` with `{ currentPassword, newPassword }`.
- Verify `currentPassword` against the stored hash (constant-time via
  `verifyPassword`); reject with `bad_credentials` on mismatch. Validate
  `newPassword` with `isAcceptablePassword`.
- On success, in one transaction: update `password_hash`, then **revoke all of
  the user's sessions _except the current one_** (the request's own
  `sessionTokenHash`, available from `requireAuth`). Return `{ ok: true }`.

### 4.2 Change email (with verification)

- `POST /api/settings/email` with `{ currentPassword, newEmail }`.
- Verify `currentPassword` (same re-auth chokepoint as above). Validate/normalise
  `newEmail`; if it equals the current email, no-op success.
- Set `users.pending_email = newEmail` (new nullable column) and mint a
  single-use `change_email` auth token (new `auth_tokens.kind`, TTL 24h, same
  cooldown/void-and-mint machinery as verify). Email the confirmation link **to
  the new address**; send a non-blocking heads-up notification **to the old
  address**. Return `{ ok: true }` (no enumeration concern — caller is
  authenticated and it's their own account).
- **New-address uniqueness** is enforced only at confirm time against the live
  `users.email` unique constraint (a `pending_email` is not yet a real email),
  so two users can have the same address pending; whoever confirms first wins,
  the loser gets `email_taken` on confirm.
- `POST /api/settings/email/confirm` with `{ token }`: the single-use token is
  the credential (as in password reset), so no live session is required. This
  lets the link work in whichever browser opens it. CAS-consume the token, then
  swap `users.email = pending_email`, clear `pending_email`. Map a
  unique-violation on the swap to `email_taken`. Sessions are **not** revoked.

### 4.3 Account deletion (24h cancellable grace period)

- `POST /api/privacy/erase` with `{ password, confirm }` (matches the shipped
  frontend contract). Verify `password`; require `confirm === "delete my
account"`. On success set `users.deletion_requested_at = now()`. **No data is
  destroyed at this point** — the request is fully cancellable.
- **Pause background work for pending accounts.** The sync scheduler, the
  classify scheduler, and the daily/quiet digest schedulers must skip users with
  `deletion_requested_at IS NOT NULL`, so no new jobs are produced; the queue
  drains to empty within ~15 min. The user stays logged in so they can cancel.
- `POST /api/privacy/erase/cancel` (authenticated): clear
  `deletion_requested_at` only while the 24h grace period has not elapsed;
  normal scheduling resumes with all data intact. Once due, cancellation is
  rejected with `deletion_due` (409).
- **Deletion sweep** — a new scheduler tick registered in `worker.ts` on the
  existing `SCHEDULER_INTERVAL_MS` (60s) cadence finds users whose grace period
  elapsed and idempotently enqueues a new `erase_account` job. The 24h is
  enforced by the query, not the cadence; the 1-minute tick just makes erasure
  prompt (~24h + <1min). The worker handler locks/rechecks the user and performs
  `DELETE FROM users` only if `deletion_requested_at <= now() - interval '24
hours'`, so a cancellation race cannot erase a restored account. It then
  scrubs the user id from its own JSONB payload so the retained queue-history
  row is anonymous. By then every prior account job is long terminal, so the
  cascade delete (which drops `channel`/`delivery_settings`/`user` rows that a
  running `deliver_channel` job would otherwise touch) is race-free. This keeps
  the cross-cutting invariant "cron triggers, workers do the work."
- Add an in-flight partial unique index on `erase_account` payload `userId`,
  matching the other queue job types, so repeated ticks cannot enqueue duplicate
  erasures.
- Frontend: `PrivacyPanel` shows a **"scheduled for deletion on {date} —
  Cancel"** banner while pending; the erase call keeps the existing
  redirect-to-`/login` only if we choose to log out — but since the account is
  cancellable, **keep the session** and re-render into the banner state instead.

### 4.4 Shared/API contract

Add request/response types to `@pigeon/shared` for the three flows, and wire the
frontend `api.ts` clients (`profile.changePassword`, `profile.changeEmail` +
`confirmEmail`, `privacy.erase` already exists → add `privacy.cancelErase`).

---

## 5. Pitfalls

- **Orphaned jobs after cascade delete.** Avoided by design: pausing schedulers
  for pending accounts drains the queue before the 24h sweep fires. No explicit
  job purge is needed (and residual failures are the already-tolerated
  disconnect-inbox behaviour). _Do not_ add a bespoke job-cleanup path — it would
  duplicate the cascade/trigger machinery.
- **Forgetting to gate a scheduler.** There are several enqueue paths (sync,
  classify, daily digest, quiet-triggered digest, quiet heartbeat). Every one
  must exclude pending-deletion users, or a job could be created seconds before
  the sweep. Add a test per scheduler.
- **Cancel versus erase race.** The cancel route and erase worker must serialize
  on the user row and both recheck the 24h deadline. A request before the
  deadline wins and preserves the account; once due, cancellation returns 409.
- **Logging the user out at t=0 breaks Cancel.** Because deletion is cancellable,
  the erase request must _not_ revoke sessions; the user needs a live session to
  reach the Cancel button.
- **Email-change enumeration / hijack.** Requiring `currentPassword` to initiate
  is the guard; do not skip it. The heads-up email to the old address is the
  detection backstop.
- **Password-change lockout.** Revoking _all_ sessions including the current one
  would immediately log the user out of the device they just used — revoke all
  _except current_.
- **`pending_email` uniqueness.** Enforce at confirm (live `email` unique
  constraint), not on `pending_email`, and map the 23505 to `email_taken`.
- **CHECK-constraint migration for the new token kind.** `auth_tokens.kind` CHECK
  must be dropped and re-added with `change_email` included (mirror how
  `jobs_type_check` is widened across migrations).

## 6. Related problems

- The deferred Feature 16 session-management surface (logout-everywhere, list/
  revoke sessions) shares `sessions` and the same settings screen; designing
  password-change's "revoke all except current" now makes adding those trivial
  later. Not built here.
- `privacy.export` / `privacy.consents` frontend stubs point at a future GDPR
  export/consent surface. Out of scope; left untouched.

## 7. Alternatives considered

- **Immediate hard delete + explicit job purge** (delete everything at t=0, purge
  orphaned jobs in the same transaction). Rejected: not cancellable, and it
  reintroduces the job-cleanup complexity the grace-period model avoids.
- **Disconnect inboxes at t=0, then delete account in 24h** (non-cancellable).
  Simple, but destroying data at t=0 makes the 24h a meaningless "grace" window;
  the user wants a genuine change-your-mind period, so we pause instead of
  destroy.
- **Email change confirmed on both old and new address.** More friction; the
  password re-auth + old-address heads-up already covers takeover risk.
- **Dedicated slower deletion cron (hourly).** Adds a config knob and jitter for
  no benefit; the 24h is in the WHERE clause, so reusing the 60s tick is simpler.

## 8. User stories

- As a signed-in user, I want to change my password without logging out, so I can
  rotate a credential I fear is compromised.
- As a signed-in user, I want to change my account email and confirm it from the
  new inbox, so my account follows me when my address changes.
- As a user, I want to be warned at my old address when my email is changed, so I
  can react if it wasn't me.
- As a user, I want to delete my account and all my data, and I want a short
  window to change my mind, so an accidental click isn't catastrophic.

## 9. Functional requirements

**Change password**

1. `POST /api/settings/password` requires auth, CSRF, body limit, and rate
   limiting.
2. Rejects when `currentPassword` does not match (`bad_credentials`, 401).
3. Rejects when `newPassword` fails `isAcceptablePassword` (`invalid_input`, 400).
4. On success, updates the hash and revokes every session for the user **except
   the requesting session**, in one transaction; returns `{ ok: true }`.

**Change email** 5. `POST /api/settings/email` requires auth, CSRF, body limit, rate limiting, and
a matching `currentPassword`. 6. Validates/normalises `newEmail`; a change to the current address is a success
no-op. 7. Stores `newEmail` in `users.pending_email`, mints a single-use `change_email`
token (TTL 24h) with the same void-and-mint + cooldown behaviour as verify,
emails the confirmation link to the **new** address, and sends a heads-up
(non-blocking) email to the **old** address. 8. `POST /api/settings/email/confirm` uses its single-use token as the credential
(no session required); CAS-consumes the token, swaps `users.email ←
   pending_email`, clears `pending_email`, and returns the updated profile. An
invalid/expired/consumed token → `invalid_or_expired_token` (400). 9. A confirm whose new address was taken in the meantime → `email_taken` (409);
`pending_email` is left cleared/reset appropriately. 10. Email change does **not** revoke sessions.

**Account deletion** 11. `POST /api/privacy/erase` requires auth, CSRF, body limit, rate limiting, a
matching `password`, and `confirm === "delete my account"`. 12. On success sets `deletion_requested_at = now()` and returns `{ ok: true }`;
**no data is destroyed and no session is revoked.** 13. While `deletion_requested_at IS NOT NULL`, none of the schedulers (sync,
classify, daily digest, quiet-triggered digest, quiet heartbeat) enqueue work
for that user. 14. `POST /api/privacy/erase/cancel` requires auth; before the 24h deadline it
clears `deletion_requested_at` and returns `{ ok: true }`; once due it
returns `deletion_due` (409). 15. A scheduler tick (60s cadence) idempotently enqueues `erase_account` jobs for
due users. The worker rechecks the deadline, cascade-deletes the user, and
removes the user id from the job payload; repeated ticks/jobs are harmless. 16. The Privacy panel shows a pending-deletion banner with a Cancel action while
a deletion is scheduled, and the initiating call leaves the user logged in.

## 10. Technical requirements

- New migration: `ALTER TABLE users ADD COLUMN pending_email CITEXT NULL;`
  `ALTER TABLE users ADD COLUMN deletion_requested_at TIMESTAMPTZ NULL;`; widen
  the `auth_tokens.kind` CHECK to include `change_email`; widen the `jobs.type`
  CHECK to include `erase_account`; and add its in-flight partial unique index
  (drop + re-add CHECKs per the existing migration precedent). Add a partial
  index `WHERE deletion_requested_at IS NOT NULL` to back the sweep + scheduler
  filters.
- New auth email templates: `changeEmailConfirm` (to new address, link
  `${baseUrl}/confirm-email?token=…`) and `emailChangedNotice` (to old address),
  in `backend/src/mail/templates.ts`.
- New frontend page/route to land the confirm token (mirroring `/verify` and
  `/reset-password`).
- All new backend behaviour follows the co-located `test/` convention; SQL/
  constraint/scheduler behaviour is `*.integration.test.ts`, pure validation is
  `*.test.ts` (coding-guidelines §2).

## 11. Acceptance criteria

- Changing the password with the correct current password succeeds, the old
  password no longer logs in, the new one does, and _other_ devices' sessions are
  invalidated while the current one keeps working.
- A wrong current password on either password- or email-change is rejected without
  side effects and without leaking which field was wrong beyond `bad_credentials`.
- Requesting an email change sends a link to the new address and a notice to the
  old; clicking the link swaps the login email; the pre-confirm state still logs
  in with the old address; an expired/used link is rejected.
- Requesting deletion sets the account pending, stops all background jobs for it,
  keeps the user logged in, and shows a Cancel banner. Cancelling fully restores
  normal operation. After 24h the sweep erases the user and every owned row, and
  the login no longer exists.
- `pnpm validate` (static + unit + integration/e2e + frontend build) passes.

## 12. Open questions

- None outstanding. (Session-management pieces of Feature 16 intentionally
  deferred — see Non-Goals.)

## 13. Non-goals (out of scope)

- "Log out everywhere" and "list/revoke active sessions" (device/IP/last-seen) —
  deferred to a later Feature 16 PRD.
- GDPR data **export** and **consent** management (`privacy.export` /
  `privacy.consents` stubs) — separate future work.
- Any billing/subscription cancellation on deletion (billing unbuilt).
- Audit-log "anonymous hash" retention hinted at in current `PrivacyPanel` copy —
  no audit-log infrastructure exists; the copy will be aligned to the real
  behaviour rather than building an audit log here.

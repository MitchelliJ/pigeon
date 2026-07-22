# Project Synopsis — 🕊️ Pigeon

> Connect your inboxes. Get one calm, ranked digest — and an instant nudge only
> when something actually needs you.

---

## 1. Project description

Pigeon is an email-triage SaaS that watches your inboxes and gives you back your
attention. Instead of living in your email, you connect your mailboxes and a
messaging channel you already use. For every incoming email, Pigeon writes a
one-sentence summary and sorts it into one of three buckets — _requires action_,
_important_, or _status/noise_. It then reaches you the way you chose: a
once-a-day digest of everything (ranked, most important first), or a quiet mode
that stays silent until a _requires action_ email arrives and then sends the
same ranked digest of all canonical messages since the last successful
delivery.

The promise is **simple and done-for-you**: no rules to build, no dashboards to
babysit. You keep working; Pigeon handles the watching, decides what deserves
your attention, and tells you in one place.

**Why it should exist:** people juggling several low-traffic inboxes either check
them all obsessively or miss the one message that mattered. Existing tools make
you build filters and live in the client. Pigeon inverts that — it does the
triage for you and only reaches out through a channel you already have open,
turning many noisy inboxes into a single, trustworthy signal.

It is built to run on a single Hetzner EU server, favoring solutions that add no
extra stateful infrastructure.

---

## 2. Intended users

**Primary**

- People with **multiple email accounts** that don't get daily mail but who
  still want to stay on top of the things that matter, without checking each
  inbox.

There is a single user role: the account owner who connects mailboxes and a
channel and receives digests. (A billing/admin surface exists but is the same
person.)

---

## 3. Initial capabilities

Ordered as a **walking skeleton** by build dependency: 1–7 deliver core product;
8–9 are UX/polish features added during development; 10 completes the quiet-mode loop;
11–12 make it a business; 13–15 broaden reach. Each becomes its own PRD.

1. **Project initialization & infrastructure baseline** — Stand up the backend and worker runtime in the monorepo with database, migrations, config/secret loading, containerized local + Hetzner deployment, and CI (no business logic).
2. **Authentication & user accounts** — Provide sign-up, login, and session management that every other resource attaches to.
3. **Inbox connectors (IMAP/POP3) & provider abstraction** — Offer a connect-mailbox flow with connection testing and encrypted credential storage behind a provider-agnostic interface ready for OAuth later.
4. **Incremental sync engine & watermarks** — Track per-mailbox what has already been seen and deduplicate so only genuinely new messages are ever surfaced.
5. **Job queue, workers & scheduler** — Run a durable, database-backed background job queue with a plan-configurable cron trigger that enqueues sync work executed idempotently by workers.
6. **LLM processing (summarize + classify)** — For each new email, make a single Mistral call returning a one-sentence summary and one of the three categories, honoring the user's plain-language classification instructions.
7. **Channel connectors & delivery modes (Discord)** — Deliver ranked digests to Discord in either daily-digest or quiet mode, built one-way but structured so two-way can be added later.
8. **Sync backfill date alignment** — Allow users to control the historical range of emails synced on first mailbox connect, avoiding unnecessary processing of entire archives.
9. **Initial sync progress feedback** — Surface sync status and progress to the user during initial backfill so they know the app is working.
10. **Quiet-mode triggered digests** — In quiet mode, send ranked digests only when a _requires action_ email arrives, and include all canonical messages since the last successful delivery.
11. **Plans, tiers, limits & quota enforcement** — Enforce subscription tiers that cap inbox count, sync frequency, and monthly emails processed at enqueue/processing time.
12. **Payment integration & subscription lifecycle** — Use Mollie checkout, webhooks, and a billing portal to keep each user's active tier (and limits) in sync with their subscription.
13. **OAuth provider connectors (Gmail / Microsoft)** _(later)_ — Add OAuth-based Gmail and Microsoft mailboxes to the connector abstraction, honoring each provider's scope and verification requirements.
14. **Additional channels (WhatsApp, Signal)** _(later)_ — Extend the channel abstraction once Discord has proven the model.
15. **Security hardening & rate limiting** _(later)_ — Add brute-force protection and rate limiting on auth and other abuse-prone endpoints (in-memory or DB-backed sliding window, constant-time responses), along with any cross-cutting security review (CSRF, session fixation, audit logging) identified as gaps after the auth and billing features ship. Also owns the LLM cost/failure guardrails deferred from Feature 6 (summarize/classify has no retry cap beyond the generic job queue backoff, no spend limit, and a permanently-failing email just stays silently unclassified — revisit here).
16. **Account & session management** _(later)_ — Expand the auth surface beyond the minimal sign-up/login/reset of Feature 2: standalone "log out everywhere," list and revoke active sessions (device/IP/last-seen), change password while logged in, change email (with new-address verification), and self-service account/data deletion (GDPR erasure) designed as a cascade across the user's mailboxes, emails, channels, and billing records.

> **Deferred but kept architecturally open:** two-way channel conversations and
> an agentic action layer (calendar writes, drafting/sending replies, per-contact
> tone learning that distinguishes mail _you_ wrote from mail _Pigeon_ wrote).
> None of this ships now; today's data model and processing loop must not make it
> hard to add.

---

## 4. Main screens

A single calm web app. Key surfaces:

- **Dashboard / Inbox overview** — Hero greeting, category stat cards (requires action / important / status), last-sync indicator, and a feed of triaged emails each showing its one-sentence summary, source account, and category badge.
- **Accounts (mailboxes)** — Connected mailboxes with provider badge and status (connected/syncing/error), plus a connect-mailbox flow for IMAP/POP3 (and later OAuth).
- **Channels** — Connected messaging channels (Discord first), each with its configuration.
- **Delivery settings** — Choose daily digest vs. quiet mode, delivery time, weekdays, target channel, and personal classification instructions.
- **Auth screens** — Sign-up, login, and account/session management.
- **Billing & plan** — Current tier and limits, usage against the monthly quota, upgrade/downgrade, and Mollie-hosted checkout/portal entry points.
- **Privacy & data** — Consent status, data export request, and account/data deletion (GDPR).

---

## 5. Triage model (reference)

Every new email yields a **one-sentence summary** plus one **category**:

- **Requires action** — you personally need to do something (reply, RSVP, pick up a parcel, pay something manually).
- **Important** — no action needed, but you should know (a delivery is arriving; you'll be charged an amount on a date).
- **Status / noise** — newsletters, "handed to the carrier" updates, discounts, receipts, general FYI.

Users steer the _important vs. status_ line via their own plain-language
instructions. Digests always rank _requires action_ first, then _important_, then
_status/noise_.

---

## 6. Cross-cutting principles (carried into every PRD)

- **Cron triggers, workers do the work.** Nothing heavy runs in the cron tick or request path; it's a durable, retryable background job.
- **Idempotency & dedupe.** Re-running any job never double-summarizes or double-notifies.
- **Watermark before spend.** Never call the LLM or notify for an email at or below a mailbox's watermark.
- **Quotas at the edge.** Tier limits are enforced at enqueue/processing time, not after the work is done.
- **Secrets always encrypted at rest.** No plaintext credentials, tokens, or webhooks in the database or logs.
- **GDPR by default.** EU hosting, data minimization, consent, export, and erasure are designed in from feature 1.
- **Abstractions ready to grow.** Inbox and channel connectors sit behind stable interfaces; delivery anticipates two-way and the storage/processing model anticipates a later agentic layer — without building either now.

---

## 7. Constraints & givens

- **Single box:** app, workers, and database run on one Hetzner EU machine; favor solutions that add no extra stateful services.
- **TypeScript** across the stack, with our own backend API.
- **Database:** PostgreSQL with hand-written SQL (no ORM); the job queue rides on this same database.
- **Fixed external services:** Mistral (LLM) and Mollie (payments), both EU-aligned.

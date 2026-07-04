# Project Specification — 🕊️ Pigeon

> Connect your inboxes. Get notified only when something *actually* needs you.

---

## 1. Project description

Pigeon is a email-triage SaaS that watches your inboxes and gives
you back your attention. Instead of living in your email, you connect your
mailboxes and a messaging channel you already use, and Pigeon summarizes each
incoming email in one sentence and decides whether it actually needs you. You
choose how it reaches you: a once-a-day digest of everything, or an immediate
nudge only when something urgent arrives.

It is built to be run on a single Hetzner server.

---

## 2. Intended users

**Primary**
- **people with multiple email accounts** that dont send emails every day but want to stay on top of things.

---

## 3. Feature list

Features are ordered as a **walking skeleton**: features 1–8 deliver a usable
product (connect a mailbox → sync → summarize → deliver to Discord); 9–11 turn
it into a business; 12–13 broaden providers and channels. Each feature becomes
its own PRD, where implementation and library choices are decided.

1. **Project initialization & infrastructure baseline** — Stand up our own
   backend and a worker runtime in the existing monorepo, with the database,
   migrations, configuration/secret loading, containerized local + Hetzner
   deployment, and CI (no business logic).
2. **Authentication & user accounts** — Sign-up, login, and session management
   (including OAuth) that every other resource attaches to.
3. **Inbox connectors (IMAP/POP3) & provider abstraction** — A connect-mailbox
   flow with connection testing and encrypted credential storage, behind a
   provider-agnostic interface designed to admit OAuth providers later.
4. **Incremental sync engine & watermarks** — Per-mailbox, protocol-aware
   tracking of what has already been seen, plus deduplication, so only genuinely
   new messages are ever surfaced.
5. **Job queue, workers & scheduler** — A durable background job queue backed by
   the existing database (no extra infrastructure) with a cron trigger that
   enqueues sync work and worker processes that execute it idempotently. The cron job has different time intervals based on the user plans (configurable).
6. **LLM processing (summarize + classify)** — For each new email, a single Mistral LLM
   call that returns a one-sentence summary, and a classification
   flag, persisted before the mailbox watermark advances.
7. **Channel connectors & delivery modes (Discord)** — A channel abstraction
   plus Discord delivery, offering each user a choice between a scheduled daily
   digest and urgent-only immediate notifications.
9. **Plans, tiers, limits & quota enforcement** — Subscription tiers that cap
   inbox count, sync frequency, and monthly emails processed, enforced at
   enqueue/processing time with usage counters.
10. **Payment integration & subscription lifecycle** — Mollie checkout,
    webhooks, and a billing portal that keep a user's active tier (and therefore
    their limits) in sync with their subscription state.
10. **OAuth provider connectors (Gmail / Microsoft)** *(later)* — Add OAuth-based
    Gmail and Microsoft mailboxes to the connector abstraction, honoring each
    provider's scope, verification, and security requirements.
13. **Additional channels (WhatsApp, Signal)** *(later)* — Extend the channel
    abstraction to WhatsApp and Signal once Discord has proven the model.

---

## 4. Main screens

The dashboard is a single calm web app, already prototyped against the mock API.
Key surfaces:

- **Dashboard / Inbox overview** — Hero greeting, priority stat cards
  (urgent / important / everything), last-sync indicator, and a feed of triaged
  emails each showing its one-sentence summary, source account, priority badge,
  and (for urgent items) a suggested action.
- **Accounts (mailboxes)** — Connected mailboxes with provider badge, status
  (connected/syncing/error), and unread count; a "connect mailbox" flow for
  IMAP/POP3 (and later OAuth providers).
- **Channels** — Connected messaging channels (Discord first), each with its
  configuration and the minimum priority that reaches it.
- **Digest settings** — Toggle daily digest vs. urgent-only, with delivery time,
  weekdays, and target channel.
- **Auth screens** — Sign-up, login, and account/session management.
- **Billing & plan** — Current tier and limits, usage against the monthly quota,
  upgrade/downgrade, and Mollie-hosted checkout/portal entry points.
- **Privacy & data** — Consent status, data export request, and account/data
  deletion (GDPR).

---

## 5. Cross-cutting principles (carried into every PRD)

- **Cron triggers, workers do the work.** No real work runs in the cron tick or
  the request path; everything heavy is a durable, retryable background job.
- **Idempotency & dedupe.** Re-running any job must never double-summarize or
  double-notify; deduplicate before the LLM call and before sending.
- **Watermark before spend.** Never call the LLM or notify for an email at or
  below a mailbox's watermark.
- **Quotas at the edge.** Tier limits (inboxes, frequency, monthly volume) are
  enforced at enqueue/processing time, not after the work is done.
- **Secrets always encrypted at rest.** No plaintext credentials, tokens, or
  webhooks in the database or logs.
- **GDPR by default.** EU hosting, data minimization, consent, export, and
  erasure are designed in from feature 1, not retrofitted.
- **Provider/channel abstraction.** Inbox and channel connectors sit behind
  stable interfaces so Gmail/Microsoft and WhatsApp/Signal slot in without
  reworking the core loop.

---

## 6. Constraints & givens

- **Single box:** everything (app, workers, database) runs on one Hetzner EU
  machine; favor solutions that add no extra stateful services.
- **TypeScript** across the stack; **our own backend API** (the current mock is
  a temporary stand-in, phased out as real data lands).
- **Database:** PostgreSQL with hand-written SQL (no ORM); the job queue rides on
  this same database.
- **Fixed external services:** Mistral (LLM) and Mollie (payments), both
  EU-aligned.

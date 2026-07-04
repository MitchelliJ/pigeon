# 🕊️ Pigeon

> Connect your inboxes. Get notified only when something *actually* needs you.

Pigeon watches your mailboxes over **IMAP / POP3** (or Gmail/Microsoft OAuth),
gives every incoming email a one-sentence **LLM summary** and a priority
(**urgent / important / everything**), and forwards only what matters to the
chat you already use — **Discord** today, WhatsApp & Signal when enabled.
Everything else waits for your **daily digest**. EU-flavored by design:
Mistral for summaries, Mollie for payments, one Hetzner box, GDPR built in.

This is a **full working application**: real backend, background worker,
PostgreSQL, auth, billing, GDPR surfaces, and the calm dashboard.

---

## Monorepo layout

```
pigeon/
├─ apps/
│  ├─ web/        @pigeon/web     — Astro + SolidJS dashboard (login, feed, settings, billing, privacy)
│  ├─ server/     @pigeon/server  — Hono HTTP API (auth, mailboxes, channels, billing, GDPR, dashboard)
│  ├─ worker/     @pigeon/worker  — background jobs: sync, LLM triage, delivery, digests, cleanup
│  └─ api/        @pigeon/api     — LEGACY single-file mock API (superseded by apps/server)
├─ packages/
│  ├─ shared/     types + tier limits shared with the frontend
│  ├─ config/     zod-validated env config, fails fast, secrets never logged
│  ├─ db/         pg pool, hand-written SQL migrations, embedded-postgres test helper
│  ├─ vault/      AES-256-GCM secrets vault (mailbox credentials, webhooks)
│  ├─ queue/      Postgres job queue (SKIP LOCKED, retries, idempotency) + scheduler
│  ├─ mail/       inbox providers (IMAP, POP3, mock, OAuth-IMAP) + sync engine
│  ├─ llm/        triage providers: Mistral (fetch, JSON mode) + deterministic mock
│  ├─ deliver/    channel connectors (Discord, WhatsApp, Signal) + digest engine
│  ├─ quota/      tier limits enforcement + monthly usage counters
│  └─ billing/    Mollie client + subscription lifecycle (sandbox mode without a key)
├─ tools/devdb/   embedded Postgres 17 for local dev — no Docker needed
└─ deploy/        Hetzner runbook
```

## Getting started (no Docker required)

```bash
pnpm install
cp .env.example .env    # then set VAULT_MASTER_KEY + SESSION_SECRET (see file)
pnpm dev                # devdb (Postgres :5433) + server :8788 + worker + web :4321
pnpm migrate            # once, or whenever migrations change
```

Open **http://localhost:4321** → create an account → *Add new inbox* →
**Demo inbox** connects a built-in mock mailbox with sample mail so the whole
pipeline (sync → summarize → classify → deliver) runs without any real
credentials. Add a Discord webhook channel to see notifications for real.

Useful scripts: `pnpm dev:server`, `pnpm dev:worker`, `pnpm dev:db`,
`pnpm typecheck`, `pnpm test` (91 tests; each suite boots a throwaway real
Postgres), `pnpm build`.

## Optional integrations (all env-gated, see `.env.example`)

| Env vars | Feature when set | Behavior when empty |
|---|---|---|
| `MISTRAL_API_KEY` | Real Mistral summaries/triage | Deterministic heuristic mock |
| `MOLLIE_API_KEY` | Hosted checkout + real subscriptions | Sandbox: upgrades apply instantly |
| `GOOGLE_CLIENT_ID/SECRET` | "Continue with Gmail" (OAuth/XOAUTH2) | Button hidden |
| `MICROSOFT_CLIENT_ID/SECRET` | Outlook / Microsoft 365 OAuth | Button hidden |
| `WHATSAPP_ACCESS_TOKEN` + `..._PHONE_NUMBER_ID` | WhatsApp channel | Kind disabled |
| `SIGNAL_API_URL` + `SIGNAL_SENDER_NUMBER` | Signal channel (signal-cli-rest-api) | Kind disabled |

## Architecture notes

- **Cron ticks only enqueue; workers do the work.** Durable Postgres job
  queue (`FOR UPDATE SKIP LOCKED`), exponential backoff, dead-letter rows,
  visibility-timeout reaper.
- **Watermark after persist.** Sync stores new mail, advances the protocol
  watermark (IMAP uid / POP3 UIDL set) and enqueues triage in ONE
  transaction; dedupe by Message-ID. Re-running anything never
  double-summarizes or double-notifies (the `deliveries` table dedupes sends).
- **Quotas at the edge.** Tier limits (`packages/shared`) are checked at
  mailbox connect, at sync enqueue (frequency) and BEFORE each LLM call.
- **Secrets always sealed.** Credentials/webhooks/tokens are AES-256-GCM
  vault tokens; never in logs, never in exports.
- **GDPR.** Consents at signup, audit log, JSON export, one-click erasure
  (cascade + job scrub), 90-day email retention.

## Guides

- **[SETUP.md](SETUP.md)** — local development, step by step: run the stack,
  then wire up every real connector (Mistral, mailboxes incl. OAuth,
  Discord/WhatsApp/Signal, Mollie test mode), each with a verify step.
- **[DEPLOY.md](DEPLOY.md)** — production on a Hetzner box: provisioning,
  Docker compose, Caddy/TLS, re-pointing integrations, backups, monitoring,
  updates/rollback. Note: the Docker assets were written without a Docker
  daemon available — the guide validates them before anything goes live.
# pigeon

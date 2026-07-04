# 🕊️ Pigeon — local development setup

This guide takes you from a fresh checkout to a fully working Pigeon **on
your own machine**, with real connectors: real mailboxes, real AI summaries
(Mistral), real notifications (Discord / WhatsApp / Signal), and real
payments (Mollie in test mode). It assumes no prior knowledge of this
codebase. Follow it top to bottom; every step ends with a way to check that
it worked.

> Putting Pigeon on a server for real users is a separate guide:
> **[DEPLOY.md](DEPLOY.md)**. Do this one first — everything you configure
> here (API keys, OAuth apps) carries over.

**How Pigeon is put together** (so the steps below make sense):

```
┌──────────┐   HTTP :4321   ┌─────────────┐    SQL     ┌────────────┐
│ Your     │ ─────────────▶ │  Web app    │            │ PostgreSQL │
│ browser  │                │  (Astro)    │            │  :5433     │
└──────────┘                └─────────────┘            └────────────┘
      │        HTTP :8788   ┌─────────────┐    SQL          ▲  ▲
      └───────────────────▶ │  API server │ ───────────────┘   │
                            │  (Hono)     │                    │
                            └─────────────┘                    │
                            ┌─────────────┐    SQL             │
   IMAP/POP3 ◀───────────── │  Worker     │ ───────────────────┘
   Mistral   ◀───────────── │  (jobs:     │
   Discord/WA/Signal ◀───── │  sync, AI,  │
                            │  delivery)  │
                            └─────────────┘
```

The worker does all the heavy lifting on a schedule; the API server only
answers the browser. Everything stores into one Postgres database that runs
**without Docker** (real Postgres binaries via npm).

Each integration is switched on by environment variables. If a variable is
missing, that feature runs in a safe fallback (mock summaries, sandbox
billing, hidden buttons) — so you can do the steps below in any order.

> ⚠️ **One honesty note before you start:** the app was built and tested
> against faithful fakes of every external API (91 automated tests), but
> the live third-party services were not reachable during the build. The
> "✅ Check" steps in this guide are there to validate each real
> integration the first time you use it.

---

## Part 1 — Get the app running locally

### 1.1 Prerequisites

| Tool | Version | Check with | Install |
|---|---|---|---|
| Node.js | 20+ (22 recommended) | `node --version` | https://nodejs.org |
| pnpm | 9.x | `pnpm --version` | `corepack enable` (comes with Node) |

No Docker needed for local development.

### 1.2 Install dependencies

```powershell
cd C:\Users\michi\Documents\Programming\pigeon
pnpm install
```

Expected: ends with `Done in Xs`, no red `ERR_` lines. This also downloads
the embedded Postgres binaries (~50 MB, one time).

### 1.3 Create your `.env`

```powershell
copy .env.example .env
```

Open `.env` in your editor. Two values are **required** and must be
generated (everything else can stay as-is for now):

```powershell
node -e "console.log('VAULT_MASTER_KEY=' + require('crypto').randomBytes(32).toString('base64'))"
node -e "console.log('SESSION_SECRET='  + require('crypto').randomBytes(48).toString('base64'))"
```

Copy each printed line into `.env`, replacing the empty
`VAULT_MASTER_KEY=` / `SESSION_SECRET=` lines.

What they do (and why you must not lose them):

- **`VAULT_MASTER_KEY`** encrypts every stored mailbox password, OAuth
  token and webhook URL (AES-256-GCM). If you change or lose it, those
  stored credentials become unreadable and every mailbox/channel has to be
  reconnected. Save a copy in your password manager.
- **`SESSION_SECRET`** signs login sessions. Changing it just logs everyone
  out — annoying, not fatal.

Leave `DATABASE_URL` alone — it points at the built-in dev database.

### 1.4 Start everything

```powershell
pnpm dev
```

This starts five processes in one terminal. Wait ~15 seconds and look for
these lines (order varies):

```
tools/devdb dev:  [devdb] postgres ready on port 5433 (db: pigeon, ...)
apps/server dev:  ... INFO  [server] listening host=0.0.0.0 port=8788
apps/worker dev:  ... INFO  [worker] running workerId=...
apps/web dev:     ... Local http://localhost:4321/
```

You will also see `WARN [worker] MISTRAL_API_KEY not set — using the mock
triage provider`. That's expected until Part 3.

### 1.5 Create the database tables

Open a **second terminal** (leave `pnpm dev` running):

```powershell
cd C:\Users\michi\Documents\Programming\pigeon
pnpm migrate
```

Expected: `migrations complete applied=9` (or `alreadyApplied=9` if run
before).

**✅ Check:** open a browser:
- http://localhost:8788/readyz → `{"status":"ok","db":true}`
- http://localhost:4321 → the Pigeon login screen.

### 1.6 Create your account and do a dry run

1. http://localhost:4321 → **Create an account** → any email/password
   (this is your local account, nothing is sent anywhere).
2. On the dashboard, sidebar → **Add new inbox** → choose **Demo inbox**
   → any address, any password → **Connect inbox**.
3. Within ~30 seconds the worker syncs it and three sample emails appear,
   already summarized and classified (one of them urgent).

This proves the whole pipeline (sync → AI → classification → dashboard)
works before any real credentials are involved. You can delete the demo
data later by just deleting the mailbox.

**Handy to know:**
- Clicking a *connected* inbox card in the sidebar = "sync now".
- The free tier syncs every 30 minutes. While testing, go to **/billing**
  and click *Switch to Pro* — with no payment provider configured this is
  an instant, free sandbox upgrade that gives you 5-minute syncs.
- After **any** `.env` change: stop `pnpm dev` (Ctrl+C) and start it again.

---

## Part 2 — Real notifications: Discord (10 minutes, do this first)

Discord needs no API keys on the server, so it's the easiest real
integration.

1. In Discord, pick (or create) a server where you have admin rights.
2. **Server Settings → Integrations → Webhooks → New Webhook.**
3. Give it a name ("Pigeon"), pick the channel messages should land in,
   click **Copy Webhook URL**. It looks like
   `https://discord.com/api/webhooks/1234.../AbCdEf...`.
4. Pigeon dashboard → sidebar → **Add new channel → Discord**.
5. Paste the webhook URL, pick a threshold:
   - **Urgent only** (recommended): instant pushes for urgent mail only.
   - **Important & urgent** / **Everything**: lower the bar if you want more.
6. **Connect channel.**

**✅ Check:** press **F12** in the browser (on the dashboard page) →
*Console* tab → paste and run:

```js
fetch("http://localhost:8788/api/channels", { credentials: "include" })
  .then(r => r.json())
  .then(d => fetch(`http://localhost:8788/api/channels/${d.channels[0].id}/test`,
                   { method: "POST", credentials: "include" }))
  .then(r => r.json()).then(console.log)
```

A **"🕊️ Test flight"** message should appear in your Discord channel and the
console prints `{ok: true}`. (A "send test" button in the UI is on the
wishlist — this console snippet is the interim.)

From now on, any email classified *urgent* is pushed to Discord within one
sync cycle. Try it: send yourself an email with subject
"URGENT: please reply today" once a real mailbox is connected (Part 4).

---

## Part 3 — Real AI summaries: Mistral (10 minutes)

Without this, summaries come from a simple keyword heuristic. With it, a
real LLM writes the one-sentence summary and decides urgency.

1. Go to https://console.mistral.ai and create an account.
2. In the console, make sure a workspace is selected, then go to
   **Billing** and add a payment method / prepaid credits. (Without
   billing, API calls are rejected.) Cost reality check:
   `mistral-small-latest` processes a typical email for well under
   €0.001 — a busy month of personal mail costs cents.
3. Go to **API Keys → Create new key**. Copy the key immediately (it is
   shown only once).
4. In `.env`, set:

```
MISTRAL_API_KEY=<paste the key>
MISTRAL_MODEL=mistral-small-latest
```

5. Restart: Ctrl+C in the `pnpm dev` terminal, then `pnpm dev` again.

**✅ Check:**
- The worker startup log **no longer** prints the
  "using the mock triage provider" warning.
- Connect a fresh Demo inbox (or click an inbox to sync). New summaries
  should read like natural prose instead of
  `"Sender: <first sentence of the body>"`. Worker log lines for
  `email triaged` now say `provider=mistral`.

**If it fails:** a `mistral responded 401` in the worker log means a wrong
key; `429` means no credits/billing. The email stays queued and is retried
automatically once you fix the key.

**Bonus — personal triage rules:** avatar (top right) → **Settings** →
*Your triage instructions*. Write plain language rules like
"Anything from my bank is urgent. Newsletters from Substack are important,
not noise." These are injected into the AI prompt and override the
defaults. Applies to newly processed emails.

---

## Part 4 — A real mailbox over IMAP (15 minutes)

Pigeon logs into your mailbox with an **app password** — a
provider-generated password that only grants mailbox access and can be
revoked anytime. Your real password is never used or stored, and the app
password itself is stored encrypted.

### 4.1 Get an app password

**Gmail**
1. App passwords require 2-Step Verification:
   https://myaccount.google.com/security → *2-Step Verification* → enable.
2. Then go to https://myaccount.google.com/apppasswords.
3. App name: "Pigeon" → **Create** → copy the 16-character password
   (spaces don't matter).

**Outlook / Hotmail**
1. https://account.microsoft.com/security → enable Two-step verification.
2. Same page → *App passwords* → create one.
   ⚠️ Microsoft is retiring basic auth for some account types. If the
   connection test fails with a valid app password, use the OAuth route
   (Part 6) instead.

**iCloud** — https://appleid.apple.com → Sign-In & Security →
App-Specific Passwords.

**Fastmail** — Settings → Privacy & Security → App passwords (choose
"Mail (IMAP/POP)" access).

**Anything else** — look up "app password" + "IMAP settings" in your
provider's help pages.

### 4.2 Connect it

1. Dashboard → **Add new inbox** → pick your provider (the IMAP host and
   port are pre-filled; for "Other" type them yourself — port 993, TLS).
2. Leave **Protocol** on *IMAP (recommended)*.
3. Label ("Personal"), your email address, the app password → **Connect
   inbox**.
4. Pigeon tests the login **before saving anything**. A wrong password
   shows the exact server error right in the dialog and nothing is stored.

What happens next: the first sync imports only the **5 newest** messages
(so your history isn't bulk-fed to the LLM), then watches for new mail —
every 30 min on Free, 5 min on Pro (see the sandbox-upgrade tip in 1.6).

**✅ Check:**
1. The inbox card says *Connected* and "Synced just now" appears at the top
   of the sidebar after the first sync (click the card to force one).
2. Your 5 most recent emails are on the dashboard with summaries.
3. Send yourself an email with subject "URGENT: reply needed today", click
   the inbox card to sync → it should appear as urgent and (with Part 2
   done) ping your Discord.

### 4.3 POP3 instead of IMAP

If a provider only offers POP3: same dialog, flip the **Protocol** toggle
to *POP3* — host/port switch to the provider's POP3 defaults
(e.g. `pop.gmail.com:995`). Notes:

- Gmail also needs POP enabled: Gmail → ⚙ Settings → *Forwarding and
  POP/IMAP* → Enable POP.
- iCloud has no POP3 (the toggle is disabled there).
- Prefer IMAP when available; POP3 has no folders/read-state so detection
  is purely by message IDs.

---

## Part 5 — Daily digest (5 minutes)

Everything that is **not** urgent waits for one calm daily summary instead
of pinging you. Two things must be set: *when* and *where to*.

1. **When:** sidebar digest card → **Edit schedule** → time + weekdays.
   Times are interpreted in the timezone stored in your delivery settings
   (default `Europe/Amsterdam`).
2. **Where to:** the digest needs a target channel. The UI has no picker
   for this yet, so set it once via the browser console (F12 on the
   dashboard):

```js
fetch("http://localhost:8788/api/channels", { credentials: "include" })
  .then(r => r.json())
  .then(d => fetch("http://localhost:8788/api/settings/delivery", {
    method: "PATCH",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ digestChannelId: d.channels[0].id,
                           timezone: "Europe/Amsterdam" })
  }))
  .then(r => r.json()).then(console.log)
```

(uses your first channel; check `d.channels` if you have several).

**✅ Check:** set the digest time to a few minutes from now, make sure a
non-urgent email is on the dashboard, wait. A "Your daily digest" message
arrives on the channel and those emails are marked digested. On a day with
nothing to report you get a short "All quiet 🍃 — Pigeon is watching and
everything works" note instead (toggle: `quietReassurance` in the same
PATCH). **Quiet mode** in the sidebar = digest off, urgent-only pushes.

---

## Part 6 — "Continue with Gmail/Outlook" (OAuth, ~30 minutes, optional)

App passwords (Part 4) already work fine. OAuth removes the app-password
dance for end users, at the cost of registering developer apps.

### 6.1 Google

1. https://console.cloud.google.com → project picker (top left) →
   **New project** → name "Pigeon" → Create (and select it).
2. **APIs & Services → OAuth consent screen** (a.k.a. Google Auth
   Platform → Branding):
   - User type: **External** → Create.
   - App name "Pigeon", your email for both contact fields → Save through
     the steps.
   - **Audience / Test users → Add users** → add your own Gmail address.
     (While the app is in "Testing" status, only these addresses can
     connect. Public availability requires Google's verification review
     because `https://mail.google.com/` is a restricted scope — that's a
     separate multi-week process; skip it for personal use.)
   - **Data access / Scopes → Add or remove scopes** → paste
     `https://mail.google.com/` → add, Save.
3. **APIs & Services → Credentials → + Create credentials →
   OAuth client ID**:
   - Application type: **Web application**, name "Pigeon local".
   - **Authorized redirect URIs → Add URI**:
     `http://localhost:8788/api/oauth/google/callback`
   - Create → copy the **Client ID** and **Client secret**.
4. `.env`:

```
GOOGLE_CLIENT_ID=<...>.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=<...>
```

5. Restart `pnpm dev`.

**✅ Check:** **Add new inbox** now shows *"Continue with Gmail"* under the
provider grid. Click it → Google consent (expect an "unverified app"
warning in testing mode → *Continue*) → you land back on the dashboard with
the Gmail mailbox connected. Tokens refresh automatically during sync.

### 6.2 Microsoft

1. https://entra.microsoft.com → **App registrations → New registration**:
   - Name "Pigeon".
   - Supported account types: **Accounts in any organizational directory
     and personal Microsoft accounts**.
   - Redirect URI: platform **Web**,
     `http://localhost:8788/api/oauth/microsoft/callback`.
2. On the app page: **Certificates & secrets → New client secret** → copy
   the **Value** (not the ID) immediately.
3. **API permissions → Add a permission → Microsoft Graph → Delegated**:
   add `IMAP.AccessAsUser.All`, `offline_access`, `email`, `openid`.
4. `.env` (Client ID is on the app's Overview page):

```
MICROSOFT_CLIENT_ID=<application (client) id>
MICROSOFT_CLIENT_SECRET=<secret value>
```

5. Restart `pnpm dev`.

**✅ Check:** same flow with *"Continue with Outlook / Microsoft 365"*.

---

## Part 7 — WhatsApp and Signal channels (optional)

### 7.1 WhatsApp (Meta Business Cloud API)

**Read this first:** Meta only allows free-form messages to a user within
**24 hours of that user's last message to you**. Outside that window,
delivery silently requires pre-approved template messages, which Pigeon
doesn't implement yet. Practical usage: message your Pigeon WhatsApp number
from your phone occasionally to keep the window open — or just use
Discord/Signal, which have no such rule.

1. https://developers.facebook.com → **My Apps → Create app** → use case
   "Other" → type **Business** → create.
2. On the app dashboard, find **WhatsApp → Set up**. Meta provisions a free
   **test phone number** for you.
3. On the **API Setup** page you'll see:
   - **Phone number ID** (a long number under the test number) → copy.
   - A **temporary access token** (valid 24 h) → copy for a first test.
   - **To**: add your own phone number as an allowed recipient and confirm
     the code it sends you.
4. `.env`:

```
WHATSAPP_ACCESS_TOKEN=<token>
WHATSAPP_PHONE_NUMBER_ID=<phone number id>
```

5. Restart. Dashboard → **Add new channel** → WhatsApp is no longer greyed
   out → enter **your** phone number in international format
   (`+31612345678`), pick a threshold, connect.
6. Send "hi" from your phone to the Meta test number (opens the 24 h
   window), then run the test-message snippet from Part 2 with the
   WhatsApp channel's id.

For anything longer-term, replace the 24-hour token: Meta Business
Manager → system user → generate a permanent token with the
`whatsapp_business_messaging` permission, and put that in `.env`.

### 7.2 Signal (self-hosted bridge)

Signal has no official API; the community-standard bridge is
`signal-cli-rest-api`, which you run yourself (this one does need Docker —
run it on the server/another machine if your dev box has none) and register
with a **spare phone number** that becomes your "Pigeon sender".

```bash
docker run -d --name signal-api -p 8090:8080 \
  -v signal-cli-config:/home/.local/share/signal-cli \
  -e MODE=normal bbernhard/signal-cli-rest-api:latest

# register the sender number:
curl -X POST "http://localhost:8090/v1/register/+31XXXXXXXXX"
# -> if it demands a captcha, follow the link in the error, redo with the token
curl -X POST "http://localhost:8090/v1/register/+31XXXXXXXXX/verify/<sms-code>"
```

`.env`:

```
SIGNAL_API_URL=http://localhost:8090
SIGNAL_SENDER_NUMBER=+31XXXXXXXXX
```

Restart, add a Signal channel with **your own** number as recipient, test
with the Part 2 snippet.

---

## Part 8 — Real payments: Mollie (optional, ~30 minutes)

Without a key, /billing works in **sandbox**: plan switches are instant and
free — fine for personal use. Real checkout needs a Mollie account **and a
publicly reachable API**, because Mollie confirms payments by calling your
webhook.

1. https://www.mollie.com → sign up (business details can sit in review
   while you use test mode).
2. Dashboard → **Developers → API keys** → copy the **Test API key**
   (`test_...`).
3. Make your local API public for the webhook. Easiest: ngrok.
   - https://ngrok.com → sign up (free) → follow their Windows install steps
   - `ngrok http 8788` → note the `https://xxxx.ngrok-free.app` URL.
4. `.env`:

```
MOLLIE_API_KEY=test_xxxxxxxxxxxxxxxx
API_ORIGIN=https://xxxx.ngrok-free.app
```

   (If you set up OAuth in Part 6, its redirect URIs still point at
   localhost — that's fine, OAuth and Mollie don't interfere. When you move
   API_ORIGIN permanently, update the OAuth redirect URIs too.)
5. Restart `pnpm dev`.

**✅ Check:** /billing → *Switch to Pro* → you are redirected to Mollie's
hosted checkout → choose the fake "iDEAL" test method → pay → status
"Paid". Mollie calls the webhook, and back on /billing your plan reads
**Pro** (may take a few seconds — the webhook does the switch, not the
redirect). *Downgrade* on the same page cancels. In the Mollie dashboard
you can see the test payment and the created subscription.

Going live later = swap `test_...` for the `live_...` key once Mollie has
approved your account, with `API_ORIGIN` on your production domain.

---

## Troubleshooting

| Symptom | Cause → fix |
|---|---|
| `pnpm dev` → devdb `lock file "postmaster.pid" already exists` | Shouldn't happen anymore (devdb reuses running clusters and clears stale locks). If it does: `Get-Process postgres \| Stop-Process -Force`, delete `.pgdata\postmaster.pid`, retry. |
| `/readyz` → `{"db":false}` | Database not up yet (starts in parallel) — wait 10 s. Persisting: is something else on port 5433? |
| Worker warns `using the mock triage provider` | `MISTRAL_API_KEY` empty/blank in `.env`, or you didn't restart after editing. |
| Summaries stuck at "(waiting for summary…)" | Worker not running or LLM erroring — check the `apps/worker dev:` lines in the terminal; failed jobs retry with backoff. |
| Add inbox → "connection test failed: …" | The exact IMAP/POP3 server error. Usually: wrong app password, IMAP/POP disabled in the provider's settings, or wrong host/port. Nothing was stored. |
| Browser console: 401 loops / redirected to /login | Session cookie expired or `SESSION_SECRET` changed — log in again. |
| CORS errors in console | You changed ports/origins: `WEB_ORIGIN` in `.env` must match the URL you open the web app on. |
| Channels: "kind … not enabled on this server" | That channel's env vars are unset (Part 7) — restart after setting them. |
| Everything broke after changing `VAULT_MASTER_KEY` | Stored credentials are unreadable by design. Restore the old key, or delete + reconnect all mailboxes/channels. |
| Mollie checkout works but the plan doesn't change | Mollie couldn't reach the webhook: `API_ORIGIN` must be the public (ngrok/production) URL and `pnpm dev` restarted after setting it. |

## Final checklist

| # | Integration | Env vars | Done when… |
|---|---|---|---|
| 1 | Base app | `VAULT_MASTER_KEY`, `SESSION_SECRET` | login works, demo inbox produces summaries |
| 2 | Discord | — | test message lands in your channel |
| 3 | Mistral | `MISTRAL_API_KEY` | no mock warning; natural-language summaries |
| 4 | IMAP/POP3 mailbox | — | self-sent "URGENT" mail appears + pings Discord |
| 5 | Digest | `digestChannelId` (console PATCH) | digest arrives at the set time |
| 6 | Google OAuth | `GOOGLE_CLIENT_ID/SECRET` | "Continue with Gmail" round-trips |
| 7 | Microsoft OAuth | `MICROSOFT_CLIENT_ID/SECRET` | same for Outlook |
| 8 | WhatsApp | `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID` | test message on your phone (24 h window rule!) |
| 9 | Signal | `SIGNAL_API_URL`, `SIGNAL_SENDER_NUMBER` | test message on your phone |
| 10 | Mollie | `MOLLIE_API_KEY`, public `API_ORIGIN` | test checkout flips the plan to Pro |

Remaining known gaps: no UI picker yet for the digest target channel
(Part 5 console snippet) and no in-UI "send test message" button (Part 2
snippet); WhatsApp free-form delivery is bounded by Meta's 24-hour rule;
public Gmail OAuth requires Google's restricted-scope verification.

**Next step:** ready to put this on a server for real users? Continue with
**[DEPLOY.md](DEPLOY.md)**.

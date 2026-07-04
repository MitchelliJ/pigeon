# 🕊️ Pigeon — production deployment guide

This guide takes Pigeon from "works on my machine" to a real, HTTPS-served
deployment on a single **Hetzner** server, the way the project is designed
to run: one box with Postgres, the API server, and the worker in Docker,
plus Caddy serving the web app and terminating TLS.

**Do [SETUP.md](SETUP.md) first.** You should already have a working local
instance and (where you want them) a Mistral key, OAuth apps, channel
credentials, and a Mollie account — this guide reuses all of them and only
covers what changes in production.

> ⚠️ **Read before starting:** the Dockerfiles, `docker-compose.yml` and CI
> workflow in this repo were written without a Docker daemon available and
> have **never been executed**. Step 4 validates them before anything
> public depends on them. Expect to possibly fix small issues there —
> that's normal for a first deploy.

**What you'll end up with:**

```
                    ┌──────────────────────── Hetzner box ───────────────────────┐
 https://app.…  ──▶ │ Caddy ──▶ static files  (apps/web/dist)                    │
 https://api.…  ──▶ │ Caddy ──▶ :8788 server ──┐                                 │
                    │                          ├──▶ Postgres (Docker volume)     │
 IMAP / Mistral /   │           worker ────────┘                                 │
 Discord / Mollie ◀─│  (Docker compose: db + migrate + server + worker)          │
                    └────────────────────────────────────────────────────────────┘
```

**You need:** a Hetzner Cloud account (https://console.hetzner.cloud), a
domain you control, your SSH public key, and ~2 hours the first time.

---

## Step 1 — Provision the server

1. https://console.hetzner.cloud → your project → **Add server**.
2. Location: **Falkenstein** or **Helsinki** (EU — this matters for the
   GDPR posture).
3. Image: **Ubuntu 24.04**.
4. Type: shared vCPU, **CX22** (2 vCPU / 4 GB / ~€4) — plenty to start.
5. **SSH keys → Add SSH key** → paste your public key
   (`type $env:USERPROFILE\.ssh\id_ed25519.pub` on Windows; generate one
   with `ssh-keygen -t ed25519` if you have none).
6. **Firewalls → Create firewall** and attach it:
   - Inbound TCP 22 (SSH), 80 (HTTP), 443 (HTTPS) — nothing else.
7. Create the server, note its **IPv4 address** (call it `<IP>` below).

**✅ Check:** `ssh root@<IP>` from your machine logs you in without a
password prompt.

## Step 2 — Prepare the box

```bash
ssh root@<IP>

apt update && apt upgrade -y
apt install -y docker.io docker-compose-v2 caddy rsync
systemctl enable --now docker caddy
docker --version && docker compose version && caddy version
```

Basic hardening (5 minutes, worth it):

```bash
# unattended security updates
apt install -y unattended-upgrades
dpkg-reconfigure -plow unattended-upgrades

# SSH: keys only
sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
systemctl restart ssh
```

## Step 3 — DNS

At your DNS provider, create two **A records** pointing at `<IP>`:

| Record | Value |
|---|---|
| `app.yourdomain.eu` | `<IP>` |
| `api.yourdomain.eu` | `<IP>` |

**✅ Check:** `nslookup api.yourdomain.eu` returns `<IP>`. (DNS can take a
few minutes; Caddy in Step 6 needs it resolving before it can get TLS
certificates.)

## Step 4 — Code onto the box + validate the Docker assets

From **your machine** (repo root):

```powershell
# copies the repo, skipping local-only junk
rsync -av --exclude node_modules --exclude .pgdata --exclude dist --exclude .astro --exclude .env ./ root@<IP>:/opt/pigeon/
```

(No rsync on Windows? `scp -r` the folder, or push to a private git remote
and `git clone` on the box — once you set one up.)

Then on the box:

```bash
cd /opt/pigeon
docker compose config        # parses + resolves the compose file
```

**✅ Check:** `docker compose config` prints the resolved YAML and exits
without errors (warnings about unset optional variables are fine). This is
the first time these files meet a real Docker — if it complains, the error
message names the exact line to fix.

## Step 5 — Production `.env`

```bash
cd /opt/pigeon
cp .env.example .env
nano .env
```

Set these (generate fresh secrets **on the box** — don't reuse dev ones):

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"   # VAULT_MASTER_KEY
node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"   # SESSION_SECRET
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"      # POSTGRES_PASSWORD
```

```
NODE_ENV=production
LOG_LEVEL=info
POSTGRES_PASSWORD=<generated>        # compose builds DATABASE_URL from this
VAULT_MASTER_KEY=<generated>         # BACK THIS UP — losing it orphans all stored credentials
SESSION_SECRET=<generated>
WEB_ORIGIN=https://app.yourdomain.eu
API_ORIGIN=https://api.yourdomain.eu

# carry over from local setup, same values:
MISTRAL_API_KEY=...
MOLLIE_API_KEY=...                   # test_... until Mollie approves you, then live_...
GOOGLE_CLIENT_ID=... / GOOGLE_CLIENT_SECRET=...
MICROSOFT_CLIENT_ID=... / MICROSOFT_CLIENT_SECRET=...
WHATSAPP_ACCESS_TOKEN=... / WHATSAPP_PHONE_NUMBER_ID=...
SIGNAL_API_URL=... / SIGNAL_SENDER_NUMBER=...
```

Notes:
- You do **not** set `DATABASE_URL` here — compose composes it from
  `POSTGRES_PASSWORD` and points it at the `db` container.
- The production database starts **empty**. Users re-register; nothing
  moves over from your dev `.pgdata` (by design — dev data is test data).
- Back up `VAULT_MASTER_KEY` and `POSTGRES_PASSWORD` in your password
  manager **now**.

## Step 6 — Start the stack

```bash
cd /opt/pigeon
docker compose up -d --build     # first build takes a few minutes
docker compose ps
```

Compose starts things in order: `db` (waits until healthy) → `migrate`
(one-shot, applies all migrations, exits) → `server` + `worker`.

**✅ Check:**

```bash
docker compose ps            # db/server "running (healthy)", migrate "exited (0)"
curl -s localhost:8788/healthz   # {"status":"ok",...}
curl -s localhost:8788/readyz    # {"status":"ok","db":true}
docker compose logs worker | tail -5   # "worker running", periodic tasks listed
```

If `migrate` exited non-zero: `docker compose logs migrate` shows which
migration failed and why.

## Step 7 — Build the web app and configure Caddy

The web app is static files with the API address **baked in at build
time**. Build it on the box (or locally and rsync `apps/web/dist`):

```bash
cd /opt/pigeon
corepack enable && pnpm install
PUBLIC_API_BASE=https://api.yourdomain.eu pnpm --filter @pigeon/web build
# output: /opt/pigeon/apps/web/dist
```

Replace `/etc/caddy/Caddyfile` with:

```
api.yourdomain.eu {
    reverse_proxy 127.0.0.1:8788
}

app.yourdomain.eu {
    root * /opt/pigeon/apps/web/dist
    file_server
    try_files {path} {path}/index.html /index.html
}
```

```bash
systemctl reload caddy
```

Caddy fetches Let's Encrypt certificates automatically on the first
request (DNS from Step 3 must be live).

**✅ Check:**
- https://api.yourdomain.eu/healthz → `{"status":"ok",...}` with a valid
  padlock.
- https://app.yourdomain.eu → Pigeon login page.
- Create an account, connect a **Demo inbox**, see summaries appear — the
  same dry run as local, now in production. (`NODE_ENV=production` also
  turns on secure, HTTPS-only session cookies.)

## Step 8 — Re-point the integrations at production

Everything keyed to `API_ORIGIN`/`WEB_ORIGIN` needs its production URL
registered on the provider side:

| Integration | What to change | Where |
|---|---|---|
| Google OAuth | Add redirect URI `https://api.yourdomain.eu/api/oauth/google/callback` | Google Cloud console → Credentials → your OAuth client |
| Microsoft OAuth | Add redirect URI `https://api.yourdomain.eu/api/oauth/microsoft/callback` | Entra → App registrations → Authentication |
| Mollie | Nothing manual — Pigeon passes the webhook URL (`API_ORIGIN/api/billing/webhook`) on every payment it creates. Just make sure `API_ORIGIN` is right. | — |
| WhatsApp | Replace the 24-hour test token with a **permanent** system-user token (`whatsapp_business_messaging` permission) | Meta Business Manager → system users |
| Signal | Run the bridge on the box and point `SIGNAL_API_URL` at it: `docker run -d --name signal-api --restart unless-stopped -p 127.0.0.1:8090:8080 -v signal-cli-config:/home/.local/share/signal-cli -e MODE=normal bbernhard/signal-cli-rest-api:latest` then `SIGNAL_API_URL=http://172.17.0.1:8090` (Docker's host gateway) | on the box |
| Mistral / Discord | Nothing — same key / webhook URLs work anywhere | — |

After editing `.env`: `docker compose up -d` (recreates containers with the
new environment).

**✅ Check:** one full pass of the [SETUP.md](SETUP.md) final checklist,
now against `https://app.yourdomain.eu`. For Mollie, a test checkout on the
production /billing page must flip the plan — that proves the webhook
round-trip through Caddy works.

## Step 9 — Backups (do not skip)

Nightly Postgres dump, 14 days retention:

```bash
mkdir -p /var/backups/pigeon
crontab -e
```

Add:

```
0 3 * * * cd /opt/pigeon && docker compose exec -T db pg_dump -U pigeon pigeon | gzip > /var/backups/pigeon/pigeon-$(date +\%F).sql.gz && find /var/backups/pigeon -name '*.sql.gz' -mtime +14 -delete
```

**✅ Check (actually test the restore once, now, not during a disaster):**

```bash
cd /opt/pigeon && docker compose exec -T db pg_dump -U pigeon pigeon | gzip > /tmp/test.sql.gz
gunzip -c /tmp/test.sql.gz | head -20     # readable SQL?
```

Also copy backups **off the box** (a dead server takes its own backups with
it): a Hetzner Storage Box + a second cron line with rsync is the cheap
answer. And remember: the database backup is only useful together with the
`VAULT_MASTER_KEY` you saved in Step 5.

## Step 10 — Monitoring the boring way

```bash
# is the worker alive? (updates every 30 s)
docker compose exec db psql -U pigeon pigeon \
  -c "SELECT worker_id, now() - seen_at AS age FROM worker_heartbeats;"

# is work flowing / failing?
docker compose exec db psql -U pigeon pigeon \
  -c "SELECT status, count(*) FROM jobs GROUP BY status;"
# 'failed' = dead-lettered jobs; inspect last_error on those rows

docker compose logs -f server worker      # live logs
```

Minimum viable alerting: an uptime service (e.g. a free UptimeRobot check)
on `https://api.yourdomain.eu/readyz` — it returns 503 when the database is
unreachable.

## Step 11 — Updates & rollback

```bash
# deploy a new version
rsync (or git pull) the new code to /opt/pigeon, then:
cd /opt/pigeon
docker compose up -d --build          # rebuilds, applies new migrations, restarts
PUBLIC_API_BASE=https://api.yourdomain.eu pnpm --filter @pigeon/web build   # if web changed

# roll back
restore the previous code (previous git tag / kept copy), then:
docker compose up -d --build
```

Migrations are additive so far; if a future one is destructive, take a
manual backup first (Step 9 one-liner).

---

## Go-live checklist

- [ ] `docker compose ps` — all healthy, `migrate` exited 0
- [ ] `https://api.…/readyz` → `{"db":true}` with valid TLS
- [ ] Web app loads, signup + demo-inbox dry run works in production
- [ ] Real mailbox connects; urgent test mail pings the channel
- [ ] Digest arrives at the configured time
- [ ] OAuth redirect URIs updated (if used)
- [ ] Mollie test checkout flips the plan (webhook works through Caddy)
- [ ] Backup cron installed **and a restore was tested once**
- [ ] `VAULT_MASTER_KEY` + `POSTGRES_PASSWORD` stored in a password manager
- [ ] Uptime check on `/readyz`
- [ ] Firewall: only 22/80/443 open; SSH password login disabled

## Production troubleshooting

| Symptom | Cause → fix |
|---|---|
| `docker compose config` errors | First real contact with the untested compose file — the message names the line; fix and re-run. |
| `migrate` exits non-zero | `docker compose logs migrate`. Usually a bad `POSTGRES_PASSWORD` change after the volume was created — either restore the old password or wipe the volume (`docker compose down -v`, **destroys data**) on a fresh install. |
| Caddy has no certificate / "connection not private" | DNS not propagated yet, or port 80/443 blocked by the Hetzner firewall. `journalctl -u caddy -e` shows the ACME errors. |
| Web app loads but every API call fails (CORS) | `WEB_ORIGIN` in `.env` doesn't exactly match `https://app.yourdomain.eu`, or the web app was built with the wrong `PUBLIC_API_BASE`. Fix, `docker compose up -d`, rebuild web. |
| Login works locally but not in prod | Cookies are `Secure` in production — the site must actually be served over HTTPS (through Caddy, not `http://<IP>:8788`). |
| OAuth: `redirect_uri_mismatch` | The production callback URL isn't registered in the Google/Microsoft console (Step 8), or `API_ORIGIN` has a typo/trailing slash. |
| Mollie payment succeeds but tier doesn't change | Webhook unreachable: `API_ORIGIN` wrong, or Caddy not proxying `api.…`. Check `docker compose logs server` for `POST /api/billing/webhook` entries. |
| Worker heartbeat age keeps growing | Worker crashed/looping — `docker compose logs worker`. Jobs are durable; they resume after `docker compose restart worker`. |

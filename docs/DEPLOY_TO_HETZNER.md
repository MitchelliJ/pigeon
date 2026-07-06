# Deploying Pigeon (single Hetzner EU box)

Pigeon is designed for one machine: the app, the worker, and the database all
run together, with no extra stateful services. This is the production runbook;
for local development see `LOCAL_SETUP.md`.

## Target

- **Hetzner Cloud, EU region** (e.g. `hel1` / `fsn1` / `nbg1`). Choose a CX
  instance (start at CX22; size up if the worker or sync load grows). EU
  hosting is a hard constraint (GDPR by default — see `vibes/spec-pigeon.md`).
- **OS:** Ubuntu Server LTS. Install Docker Engine + the `docker compose`
  plugin (don't use Docker Desktop; that's a dev tool).

## Provision

```sh
# on the fresh server, as root/sudo:
apt-get update && apt-get -y upgrade
# install Docker Engine + compose plugin per docs.docker.com for Ubuntu
git clone <your-pigeon-repo-url> /opt/pigeon && cd /opt/pigeon
cp .env.example .env
# edit .env on the server:
#   POSTGRES_PASSWORD=<long random secret>     # used by the compose db + DATABASE_URL
#   LOG_LEVEL=info                              # or warn in prod
#   PORT=8788                                   # the public API port (behind Caddy)
# Set DATABASE_URL to match POSTGRES_PASSWORD. The compose `&appenv` already
# builds DATABASE_URL as postgres://pigeon:${POSTGRES_PASSWORD}@db:5432/pigeon,
# so you usually only need POSTGRES_PASSWORD + LOG_LEVEL.
```

`.env.old` at the repo root is a reference of future-feature keys (Mistral,
Mollie, Discord, vault, OAuth). It is **not** read in production today; it
documents what later features will need. Leave it untouched.

## Bring the stack up

```sh
docker compose up --build -d
```

This:

1. starts **Postgres 17** (`db`, `pgdata` volume, healthchecked);
2. runs the **`migrate` one-shot service** (`pnpm migrate`) once it's healthy —
   applying the forward-only `db/migrations/*.sql` files tracked in
   `schema_migrations`, each in its own transaction;
3. starts the **API** (`server`) and the **worker** only after `migrate`
   exits 0 (`depends_on: service_completed_successfully`).

Re-running `docker compose up --build -d` rebuilds and re-runs migrations
idempotently (already-applied files are skipped; a stale higher applied id is
rejected — see `backend/src/migrate/runner.ts` FR-8).

Verify:

```sh
docker compose ps                       # db healthy, server/worker Up, migrate Exited (0)
curl localhost:8788/readyz               # {"ok":true} when the DB is reachable
docker compose logs -f worker           # heartbeats + scheduler/job-queue tick activity
```

## Edge / TLS

The frontend is a static Astro build (`pnpm build` → `frontend/dist`). Serve it
at the edge with a reverse proxy in front of the box:

- **Caddy** is the simplest choice: it auto-provisions Let's Encrypt TLS for
  your domain and reverse-proxies `/` to the static Astro build and
  `/healthz`,`/readyz` (and future `/api`) to `localhost:8788`. A minimal
  `Caddyfile`:

  ```
  pigeon.example.com {
    handle /healthz  { reverse_proxy localhost:8788 }
    handle /readyz   { reverse_proxy localhost:8788 }
    handle /api/*     { reverse_proxy localhost:8788 }   # future API surface
    handle            { root * /opt/pigeon/frontend/dist; file_server }
  }
  ```

- Point Caddy's `/readyz` healthcheck at `GET /readyz` — 200 means the API is up
  _and_ the DB is reachable; 503 means do not route traffic.

Keep port 8788 private (firewall it); only Caddy should reach it. Expose 80/443
only.

## Backups

The only stateful data is the **`pgdata`** Docker volume. Back it up with a
consistent Postgres dump (don't copy live files):

```sh
docker compose exec -T db pg_dump -U pigeon pigeon | gzip > pigeon-$(date +%F).sql.gz
```

Schedule a daily cron; copy dumps off-box (e.g. to Hetzner Storage Box). Keep
enough history to roll back a bad migration. The `db` container's
`pgdata` volume itself can also be snapshotted at the Hyperscaler level, but a
`pg_dump` is the portable, version-stable artifact.

## Updates

```sh
cd /opt/pigeon
git pull --ff-only
docker compose up --build -d
```

The rebuild re-runs migrations. Because migrations are **forward-only**, an
update only ever adds new `NNNN_*.sql` files. There is no down-migration —
rollbacks are constrained (see below).

## Rollback

If an update breaks, roll the _image_ back to the previous build:

```sh
git checkout <previous-good-commit>
docker compose up --build -d
```

**Important:** if the bad update already applied a new migration, the rollback
image's migration runner will refuse to proceed (FR-8: an applied id higher
than the highest file on disk is rejected). To recover, either forward-fix the
bad migration with a new corrective `NNNN_*.sql`, or restore `pgdata` from a
backup taken before the bad update. Never hand-edit `schema_migrations`.

## Monitoring (today)

Logs go to stdout; `docker compose logs -f` is the primary lens. `LOG_LEVEL`
controls verbosity. A richer metrics/tracing layer is deferred to a later ops
feature; for now, alert on:

- `readyz` returning 503 for >1m (DB or API down),
- the `worker` not heartbeating for several intervals,
- repeated `[scheduler] tick failed`/`[worker] tick failed` lines in the
  worker's logs (a single failure is caught and logged, not fatal, but a
  repeating pattern means something's actually broken),
- the `migrate` one-shot exiting non-zero on an update.

## Local parity

The same `docker-compose.yml` runs locally (see `LOCAL_SETUP.md` →
"Containerized stack"), so a `docker compose up --build` on your laptop
exercises the same
migrate-then-serve flow prod uses. CI (`pnpm test`) exercises the migration
runner and CLI against an embedded Postgres, and the `image` job builds this
same Dockerfile.

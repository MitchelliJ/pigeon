# Commands

The canonical command contract now lives at the repo root: **[`../COMMANDS.md`](../COMMANDS.md)**.
That file is the single source of truth for dev, test (unit + integration),
static checks, and complete validation. This page keeps only the longer-form
notes that don't belong in the terse contract.

See also `LOCAL_SETUP.md` for first-time local setup and `deploy/hetzner.md`
for the single-Hetzner-box production runbook.

## Migrations — semantics

`pnpm migrate` applies forward-only `db/migrations/NNNN_name.sql` files
idempotently, tracked in the `schema_migrations` table, each in its own
transaction. Re-running is a no-op: already-applied files are skipped. An
applied migration id higher than anything on disk is rejected (an out-of-order
guard — see `backend/src/migrate/runner.ts`). There are no down-migrations;
rollbacks are constrained to restoring the `pgdata` volume from a backup or
forward-fixing with a new corrective migration (see `deploy/hetzner.md`).

`pnpm migrate` runs `backend/src/migrate/cli.ts`, which reads `DATABASE_URL`
from the environment (validated via `backend/src/config`). In development
`DATABASE_URL` defaults to the docker-compose value, so you can run it against
a composed Postgres or any reachable engine.

## Invites — semantics

Sign-up is invite-only unless `SIGNUP_OPEN=true`. `pnpm invite` mints one or
more codes (printed to stdout once, in plaintext — only their hash is
persisted); `pnpm invite --count 5 --ttl 7d` mints several with an optional TTL
(`s`/`m`/`h`/`d`; omit `--ttl` for codes that never expire). It runs
`backend/src/auth/invite-cli.ts`, which reads `DATABASE_URL` the same way
`pnpm migrate` does.

## Mail in development

Without a `RESEND_API_KEY` set, `NODE_ENV=development` and `NODE_ENV=test` both
fall back to an in-process mock mail provider instead of calling Resend.
Verification and password-reset emails are logged to stdout at `LOG_LEVEL=info`
as a subject line plus a clickable link, so you can complete the sign-up /
reset flow locally without a real Resend account:
`[mail:mock] to=you@example.com subject="Verify your email" link=http://localhost:4321/verify?token=...`

Set `RESEND_API_KEY` (and `MAIL_FROM`, `APP_BASE_URL`) to send through Resend
instead, even outside production.

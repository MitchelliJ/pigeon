# Pigeon — Coding Guidelines

> Living reference for architecture, structure, style, testing, and workflow.
> This is the authoritative source of truth for _how_ we build Pigeon. Keep it
> current whenever a convention changes. Read alongside `vibes/spec-pigeon.md`
> (what we're building) and `docs/COMMANDS.md` (how to run it).

---

## 1. Tech stack

Everything runs on **TypeScript** and is designed to live on a **single Hetzner
EU box** with no extra stateful services (per the spec's constraints).

### Frontend (`frontend/`)

| Choice | Why |
| --- | --- |
| **Astro 5** | Ships mostly static HTML with islands of interactivity — fast, calm, SEO-friendly. Matches a "single calm web app" with a few dynamic panels. |
| **SolidJS** (via `@astrojs/solid-js`) | Fine-grained reactivity for the interactive islands (dashboard, dialogs) without a heavy runtime. |
| **Plain CSS** (`src/styles/global.css`) | No CSS framework; small surface, full control. |
| Cookie-session API client (`src/lib/api.ts`) | Talks to the backend with `credentials: "include"`; a 401 anywhere bounces to `/login`. |

### Backend (`backend/`)

| Choice | Why |
| --- | --- |
| **Hono** + `@hono/node-server` | Tiny, fast, standards-based HTTP framework. One app for the API. |
| **Node 22** (ESM, run via `tsx`) | Pinned runtime; `tsx` runs TypeScript directly in dev and prod — no build step for the backend. |
| **Worker process** (`src/worker.ts`) | Separate long-running process for the durable job queue + scheduler. Same codebase, different entry point. |
| **Mistral** (LLM) & **Mollie** (payments) | Fixed EU-aligned external services. Both sit behind interfaces with mock/sandbox fallbacks so the app is demoable without keys. |

> The backend is intentionally a **minimal runtime scaffold** today (liveness /
> readiness + a worker heartbeat). Real modules — `db`, `queue`, `mail`, `llm`,
> `deliver`, `quota`, `billing`, `vault`, `config` — are added **feature by
> feature** under `backend/src/`, each with its own migrations and tests, when
> the corresponding PRD is built. Do **not** pre-create empty module folders.

### Shared (`shared/`)

| Choice | Why |
| --- | --- |
| `@pigeon/shared` types package | Single source of truth for the API contract (`DashboardData`, `Email`, `Channel`, tiers, …). Both frontend and backend import these — **type-only**, so there is no runtime coupling. |

### Database

| Choice | Why |
| --- | --- |
| **PostgreSQL 17** | One database for everything, including the job queue (no Redis/RabbitMQ). |
| **Hand-written SQL, no ORM** | Explicit, reviewable, portable. Queries live next to the module that owns them. |
| **Numbered SQL migrations** | Forward-only files (`NNNN_name.sql`) applied by an idempotent runner. |
| **Embedded Postgres for dev/test** | Real Postgres binaries via npm (no Docker/admin needed) so tests run against the genuine engine. |

### Tooling

- **pnpm 9** workspaces (three members: `frontend`, `backend`, `shared`).
- **ESLint 9** (flat config) + **Prettier** — ESLint for correctness, Prettier
  owns formatting; `eslint-config-prettier` keeps them from fighting.
- **Vitest** for tests. **Husky** + **lint-staged** for pre-commit.
- **Supply-chain guard:** `minimumReleaseAge: 1440` in `pnpm-workspace.yaml`
  blocks packages published < 24h ago (needs pnpm ≥ 10.16 to take effect).

---

## 2. Setup and architectural conventions

### Repository layout

```
pigeon/
├── frontend/        # Astro + SolidJS web app  (@pigeon/frontend)
│   └── src/{pages,components,layouts,lib,styles}
├── backend/         # Hono API + worker         (@pigeon/backend)
│   └── src/{server.ts, worker.ts, …modules added per feature}
├── shared/          # Type-only contract        (@pigeon/shared)
├── deploy/          # Hetzner runbook
├── docs/            # COMMANDS.md and other docs
└── vibes/           # spec + coding guidelines + PRDs
```

Only these three workspaces exist. New backend capability = a new folder under
`backend/src/` (e.g. `backend/src/mail/`), not a new workspace package.

### Module structure (backend)

- Each feature is a **self-contained folder** under `backend/src/`: its routes,
  service logic, SQL, and types together.
- **Cron triggers, workers do the work.** Nothing heavy runs in a request
  handler or a cron tick — it enqueues a durable, retryable job.
- **Provider/connector abstractions:** inbox providers (IMAP/POP3/OAuth) and
  channel connectors (Discord/…) sit behind stable interfaces so new providers
  are additive. Delivery is one-way now but structured for two-way later.
- **Two entry points, one codebase:** `server.ts` (HTTP) and `worker.ts`
  (queue + scheduler) import the same modules.

### Where tests live

- Backend/shared: co-located `test/` folders — `backend/**/test/**/*.test.ts`.
- **Integration-first:** route and job tests boot a real embedded Postgres and
  exercise the actual SQL. External services (Mistral, Mollie, Discord, IMAP)
  are faked behind their interfaces, not mocked ad hoc.
- Frontend components are not unit-tested unless they carry real logic; the
  Astro build (`pnpm build`) is the frontend's typecheck/smoke gate.

### Authentication & authorization

- **Sessions, not JWTs.** Opaque random tokens, hashed at rest, delivered as an
  `httpOnly` `SameSite=Lax` cookie with a sliding expiry.
- Passwords hashed with **scrypt** (`node:crypto`), params stored per-hash.
- A `requireAuth` middleware guards every resource; every resource attaches to
  the authenticated user. Single role: the account owner.
- Constant-time behaviour on unknown accounts (no user enumeration).

### Secrets & config

- **One `.env` at the repo root** (git-ignored), described by `.env.example`.
- Config is **validated at startup** (Zod) and the process crashes immediately,
  naming the offending variable, when something is missing or malformed.
- **Secrets never hit logs or the database in plaintext.** Credentials, tokens,
  and webhooks are sealed (AES-256-GCM) via the vault module before storage; a
  redacting config summary shows only whether a secret is set.
- `.env.old` is kept intentionally (reference values for future features) — do
  not delete it.

---

## 3. Coding standards and style

### Formatting & linting

- **Prettier owns formatting** (2-space indent, double quotes, semicolons,
  trailing commas, 80-col). Never hand-format; run `pnpm format`.
- **ESLint owns correctness.** Fix warnings; unused vars prefixed `_` are
  allowed. `pnpm check` (lint + typecheck) must pass before every commit and is
  the `go` skill's phase gate after each parent task.

### TypeScript

- **Strict everywhere**, ESM only. `noUncheckedIndexedAccess` is on — handle
  `undefined` from index access.
- Use **`import type`** for type-only imports (frontend↔shared must stay
  type-only to avoid bundling backend code).
- Prefer explicit return types on exported functions. Model domain data as
  `interface`/`type` in `shared/` when it crosses the API boundary.

### Naming conventions

- **Files/folders:** `kebab-case` (`text-format.ts`); one PascalCase per Solid
  component file (`Dashboard.tsx`) is fine.
- **Types/interfaces/classes:** `PascalCase`. **Functions/vars:** `camelCase`.
  **Constants:** `UPPER_SNAKE_CASE`. **Env vars:** `UPPER_SNAKE_CASE`.
- **DB:** `snake_case` tables and columns; migrations `NNNN_short_name.sql`.

### Documentation & comments

- Every module starts with a short block comment: what it does and why.
- Comment the **why**, not the what. Call out gotchas and invariants (e.g. the
  spec's cross-cutting rules) where the code enforces them.

### Error handling

- **Fail fast at startup** (config), **degrade gracefully at runtime**
  (missing optional integration → mock/sandbox path, not a crash).
- Jobs are **idempotent and retryable**: distinguish retryable (backoff) from
  permanent failures (dead-letter). Re-running a job never double-summarizes or
  double-notifies.
- HTTP handlers return typed JSON errors with a proper status; quota breaches
  return `403` with an upgrade hint.

### Cross-cutting rules (from the spec — enforce in every feature)

- **Watermark before spend:** never call the LLM or notify at/below a mailbox's
  watermark.
- **Quotas at the edge:** enforce tier limits at enqueue/processing time.
- **Idempotency & dedupe** on every job and every send.
- **GDPR by default:** EU hosting, data minimization, consent, export, erasure.

---

## 4. Deployment

- **Single Hetzner EU box.** `docker compose up --build` brings up Postgres, the
  backend **API**, and the **worker** (both from `backend/Dockerfile`, same
  image, different `command`). Frontend is a static Astro build served at the
  edge (Caddy/reverse proxy); see `deploy/hetzner.md`.
- **CI (GitHub Actions):** install → `pnpm lint` → `pnpm typecheck` →
  `pnpm test` (embedded Postgres, no service) → `pnpm build` → backend image
  build. Migrations run as a one-shot step re-added in feature 1.
- **Branching:** trunk-based — commit to `main`. **Conventional Commits**
  (`feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`) for a clean,
  changelog-able history.
- **Node pinned to 22** (`.nvmrc`, `engines`); pnpm 9.

---

## 5. Changelog

- **04-07-2026** — Initial coding guidelines. Restructured the repo from
  `apps/*` + `packages/*` + `tools/*` into three workspaces (`frontend`,
  `backend`, `shared`); reset the backend to a minimal runtime scaffold
  (feature modules added per-PRD); moved shared types to `shared/`. Added
  ESLint (flat) + Prettier, Husky + lint-staged, `.editorconfig`, `.nvmrc` (22),
  VS Code recommendations; updated CI, `docker-compose.yml`, and
  `backend/Dockerfile`; pinned Node 22 and adopted trunk-based development with
  Conventional Commits. Kept `.env.old` for future reference.

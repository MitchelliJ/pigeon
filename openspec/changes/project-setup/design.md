## Context

The monorepo is a pnpm workspace (`apps/*`, `packages/*`) currently holding `apps/web` (Astro + SolidJS), `apps/api` (single-file Hono mock returning fake data), and `packages/shared` (TS types). Existing conventions: Node ≥20, pnpm, ESM (`"type": "module"`), `tsx` for running TS directly, a strict `tsconfig.base.json`, and a supply-chain cooldown (`minimumReleaseAge: 1440`) in `pnpm-workspace.yaml`.

This change establishes the runtime/infrastructure foundation — backend, worker, database, config, containers, deployment, CI — with **no business logic**. Stakeholders: the solo developer; future feature changes depend on these primitives.

## Goals / Non-Goals

**Goals:**
- Stand up `apps/server` (HTTP backend) and `apps/worker` (background runtime) as real, runnable Node/TS services.
- Self-hosted PostgreSQL with a migration tool, baseline migration, and a shared connection module.
- One typed, validated config/secret module shared by both services.
- Dockerfiles + local `docker-compose` stack + a repeatable Hetzner deployment.
- CI: install, lint, typecheck, build, migrate against ephemeral Postgres, build images.
- Match existing repo conventions (pnpm workspace, ESM, strict TS, supply-chain cooldown).

**Non-Goals:**
- No email ingestion, summarization, categorization, digests, notifications, channels, or auth.
- No removal/rewrite of the existing `apps/api` mock (a later change supersedes it).
- No production observability stack, autoscaling, or managed/multi-node Postgres.

## Decisions

**Workspace layout.** Add `apps/server`, `apps/worker`, `packages/config`, `packages/db`. Server and worker are thin entrypoints that consume the shared `packages/config` and `packages/db`. *Alternative considered:* a single combined process with a worker thread — rejected because separate processes mirror the eventual deploy topology and keep scaling independent.

**Backend framework: Hono.** Reuse Hono (already a dependency via `apps/api`) with `@hono/node-server`. Keeps the stack consistent and lets a later change migrate mock routes over. *Alternative:* Fastify/Express — rejected to avoid introducing a second HTTP idiom.

**Language/runtime.** Node ≥20, TypeScript, ESM, `tsx` for dev (consistent with `apps/api`); compiled output for production images. SolidJS remains the frontend concern only.

**Config: typed schema validation.** A single `packages/config` parses `process.env` through a schema validator (e.g. Zod/valibot/envalid — final pick in tasks), exporting a typed, frozen config. Fails fast and redacts secrets in any summary log. *Alternative:* ad-hoc `process.env` reads — rejected; no validation, easy drift.

**Database access + migrations.** Self-hosted Postgres. `packages/db` exposes a `pg`-based pool. Migrations are forward-only SQL/TS files applied by a dedicated tool (e.g. `node-pg-migrate` or drizzle-kit — final pick in tasks) with a bookkeeping table; runnable via CLI and CI. Baseline migration sets up bookkeeping only, no domain tables. *Alternative:* a full ORM with auto-sync — rejected; explicit migrations are safer and reviewable.

**Containerization.** Per-service Dockerfiles (multi-stage: build → slim runtime) consuming env at runtime. `docker-compose.yml` runs Postgres + server + worker for local dev with a `.env`. *Alternative:* a single image running both — rejected; muddies the deploy model.

**Deployment: Hetzner via compose.** A single Hetzner host running the compose stack (Postgres + services), images pulled from a registry, secrets via host env / `.env` not in git. Documented, repeatable, with image-version rollback. *Alternative:* Kubernetes/Nomad — rejected as overkill at this stage.

**CI: GitHub Actions.** Workflow on push/PR: pnpm install (respecting the cooldown), lint, typecheck, build, run migrations against a service-container Postgres, build server/worker images. *Alternative:* deploy-on-merge now — deferred; CI here validates only.

## Risks / Trade-offs

- **Two long-running services increase local/deploy complexity** → docker-compose makes the full stack a one-command start; server and worker share config/db packages to limit divergence.
- **Self-hosting Postgres on a single Hetzner host is a SPOF with manual backups** → acceptable for this stage; document backup/restore and keep migrations forward-only so restore is predictable. Revisit managed/replicated DB before real user data.
- **Secrets handled via env files risk accidental commits** → only an example env with placeholders is committed; real `.env` is gitignored; config redacts secrets in logs.
- **Supply-chain cooldown (`minimumReleaseAge`) may block a needed new dependency** → use the documented `minimumReleaseAgeExclude` escape hatch only for genuine blockers.
- **Tooling picks (validator, migration tool) not yet final** → narrowed to named candidates; locked during tasks to avoid blocking design approval.

## Migration Plan

1. Add workspace packages/apps and dependencies (respecting cooldown); wire root scripts.
2. Implement `packages/config`, `packages/db`, baseline migration; verify migrate locally.
3. Implement `apps/server` and `apps/worker` against config/db; verify health/heartbeat.
4. Add Dockerfiles + `docker-compose`; verify full local stack and migrations.
5. Add GitHub Actions CI; verify all steps green on a PR.
6. Provision Hetzner host; document + execute first deploy; verify health endpoint.
- **Rollback:** services are stateless — redeploy the previous image tag; DB protected by forward-only migrations plus documented backup/restore.

## Open Questions

- Final config-validation library and migration tool (locked in tasks).
- Container registry choice (GHCR vs other) for CI-built images.
- Hetzner provisioning detail: plain Docker host now vs. light IaC — start manual/documented, revisit later.

## Why

The repo today is frontend-only: an Astro/SolidJS dashboard talking to a single-file mock API (`apps/api`) that returns fake data. Before any of Mailpigeon's real capabilities (inbox watching, summarization, categorization, digests, urgent nudges) can be built, we need a real backend, a place to run background work, a database, and a repeatable way to configure, run, and deploy it all. This change lays that foundation — infrastructure only, no business logic — so subsequent feature changes have a stable platform to build on.

## What Changes

- Add a real backend service (`apps/server`) — a Node.js/TypeScript HTTP service with a health endpoint and config-driven startup. It does **not** yet implement Mailpigeon features.
- Add a worker runtime (`apps/worker`) — a long-running Node.js/TypeScript process for background/scheduled work, with a heartbeat/liveness signal but no jobs yet.
- Add a self-hosted PostgreSQL database with a migration tool and an initial baseline migration, plus a shared DB access package for connection/pooling.
- Add centralized configuration and secret loading: a single typed, validated config module shared across server and worker that fails fast on missing/invalid values.
- Add containerization: Dockerfiles for server and worker, and a `docker-compose` stack for local development (server + worker + Postgres).
- Add deployment to Hetzner: build/publish container images and deploy the compose stack (or equivalent) to a Hetzner host.
- Add CI: lint, typecheck, build, run migrations against a throwaway Postgres, and build container images on every push/PR.
- The existing mock `apps/api` is left in place for the frontend; the new `apps/server` will supersede it in a later change (not removed here).

## Capabilities

### New Capabilities
- `backend-service`: A configurable Node.js/TypeScript HTTP backend skeleton with health/readiness endpoints and graceful startup/shutdown.
- `worker-runtime`: A long-running background worker process with liveness signaling and graceful shutdown, sharing config and DB access with the backend.
- `database`: Self-hosted PostgreSQL with versioned migrations, a baseline migration, and a shared connection/pooling module.
- `configuration`: Centralized, typed, validated environment-based configuration and secret loading shared across services, failing fast on invalid input.
- `containerized-deployment`: Dockerized server and worker images, a local `docker-compose` development stack, and deployment to a self-hosted Hetzner host.
- `ci-pipeline`: Continuous integration that installs, lints, typechecks, builds, runs migrations against an ephemeral Postgres, and builds images.

### Modified Capabilities
<!-- None — there are no existing specs in openspec/specs/ and this change introduces only infrastructure. -->

## Impact

- **Monorepo**: new `apps/server`, `apps/worker`; likely new `packages/config` and `packages/db` (shared config + database access). Root `package.json` scripts and `pnpm-workspace.yaml` updated.
- **Tooling/deps**: Postgres driver and migration tool, a config/validation library, Docker + docker-compose, CI workflow files.
- **Infra**: a Hetzner host running Postgres and the containerized services; build/registry for images; secrets provisioned via environment.
- **Existing code**: `apps/web` and `apps/api` (mock) unchanged; `@pigeon/shared` may gain shared types but no behavior change.
- **No business logic**: no email ingestion, summarization, categorization, notifications, or auth in this change.

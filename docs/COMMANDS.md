# Commands

Frequently-used commands for the Pigeon monorepo. Run from the repo root
unless noted. Requires Node 22 (`nvm use`) and pnpm 10 (≥ 10.16).

# Development

Start the frontend (Astro, http://localhost:4321) and backend API
(Hono, http://localhost:8788) together, with hot reload:
`pnpm dev`

Run the background worker (separate terminal):
`pnpm dev:worker`

Individual processes:
`pnpm dev:frontend` · `pnpm dev:backend`

# Check (lint + typecheck + unit tests)

Full local gate before pushing — ESLint, all workspace typechecks, and the
Vitest suite:
`pnpm check:all`

# Lint & Typecheck (phase gate)

Static checks only (no tests). This is the gate the `go` skill runs after each
parent task:
`pnpm check`

# Other

Auto-fix lint issues:
`pnpm lint:fix`

Format the whole repo with Prettier:
`pnpm format`

Check formatting without writing:
`pnpm format:check`

Typecheck every workspace:
`pnpm typecheck`

Run the test suite once:
`pnpm test`

Build the frontend for production:
`pnpm build`  ·  preview it: `pnpm preview`

Build & run the full stack in containers (Postgres + API + worker):
`docker compose up --build`

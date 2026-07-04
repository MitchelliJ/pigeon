# Pigeon background worker. Build from the REPO ROOT:
#   docker build -f apps/worker/Dockerfile -t pigeon-worker .
FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /app

# ---- install (workspace-aware, cached by lockfile) -------------------------
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY apps/worker/package.json apps/worker/
COPY packages/config/package.json packages/config/
COPY packages/db/package.json packages/db/
COPY packages/vault/package.json packages/vault/
COPY packages/queue/package.json packages/queue/
COPY packages/mail/package.json packages/mail/
COPY packages/llm/package.json packages/llm/
COPY packages/deliver/package.json packages/deliver/
COPY packages/quota/package.json packages/quota/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile --filter @pigeon/worker... --prod=false

# ---- runtime ---------------------------------------------------------------
FROM base AS runtime
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY pnpm-workspace.yaml package.json .npmrc ./
COPY packages ./packages
COPY apps/worker ./apps/worker
WORKDIR /app/apps/worker
# Liveness = recent row in worker_heartbeats; compose/systemd checks the DB.
CMD ["npx", "tsx", "src/index.ts"]

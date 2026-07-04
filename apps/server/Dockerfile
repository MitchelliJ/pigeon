# Pigeon backend server. Build from the REPO ROOT:
#   docker build -f apps/server/Dockerfile -t pigeon-server .
FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /app

# ---- install (workspace-aware, cached by lockfile) -------------------------
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY apps/server/package.json apps/server/
COPY packages/config/package.json packages/config/
COPY packages/db/package.json packages/db/
COPY packages/vault/package.json packages/vault/
COPY packages/queue/package.json packages/queue/
COPY packages/mail/package.json packages/mail/
COPY packages/llm/package.json packages/llm/
COPY packages/deliver/package.json packages/deliver/
COPY packages/quota/package.json packages/quota/
COPY packages/billing/package.json packages/billing/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile --filter @pigeon/server... --prod=false

# ---- runtime ---------------------------------------------------------------
FROM base AS runtime
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY pnpm-workspace.yaml package.json .npmrc ./
COPY packages ./packages
COPY apps/server ./apps/server
# Workspace packages ship TypeScript directly; tsx runs it in production.
WORKDIR /app/apps/server
EXPOSE 8788
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8788/healthz || exit 1
CMD ["npx", "tsx", "src/index.ts"]

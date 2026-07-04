# Pigeon backend image — serves both the API (default) and the worker.
# Pick the process at runtime:  command: ["pnpm","start"]  or  ["pnpm","start:worker"]
FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /app

# Install workspace deps (backend + shared) with the lockfile.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY backend/package.json ./backend/
COPY shared/package.json ./shared/
RUN pnpm install --frozen-lockfile --filter @pigeon/backend...

# App source.
COPY tsconfig.base.json ./
COPY shared ./shared
COPY backend ./backend

WORKDIR /app/backend
EXPOSE 8788
CMD ["pnpm", "start"]

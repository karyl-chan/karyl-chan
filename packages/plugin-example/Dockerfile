# syntax=docker/dockerfile:1
#
# Multi-stage build for @karyl-chan/plugin-example inside the pnpm
# monorepo.
#
# IMPORTANT: the build context MUST be the karyl-chan monorepo root so
# pnpm-workspace.yaml, pnpm-lock.yaml, and sibling workspace packages
# (@karyl-chan/plugin-sdk, @karyl-chan/ui) are visible. The compose
# file at docker-compose.plugins.yml sets:
#   context: ./karyl-chan
#   dockerfile: packages/plugin-example/Dockerfile

FROM node:22-bullseye-slim AS base
RUN corepack enable
WORKDIR /repo
# Workspace + per-package manifests only, copied before sources so the
# `pnpm install` layer caches when only app code changes.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/plugin-sdk/package.json packages/plugin-sdk/
COPY packages/ui/package.json packages/ui/
COPY packages/plugin-example/package.json packages/plugin-example/


FROM base AS build
# Build toolchain for better-sqlite3's native compile.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
RUN pnpm install --frozen-lockfile --filter @karyl-chan/plugin-example...
COPY packages/plugin-sdk packages/plugin-sdk
COPY packages/ui packages/ui
COPY packages/plugin-example packages/plugin-example
RUN pnpm --filter @karyl-chan/plugin-sdk build \
    && pnpm --filter @karyl-chan/plugin-example build
# Flatten plugin-example + its production deps into a self-contained
# tree. `pnpm deploy` resolves the workspace's symlinks into a real
# node_modules suitable for the runtime image. --legacy because
# plugin-example has workspace deps that aren't `injected: true`.
RUN pnpm --filter @karyl-chan/plugin-example deploy --legacy --prod /app


FROM node:22-bullseye-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
RUN mkdir -p /app/data && chown -R node:node /app/data
VOLUME /app/data
USER node
EXPOSE 3000
CMD ["node", "dist/index.js"]

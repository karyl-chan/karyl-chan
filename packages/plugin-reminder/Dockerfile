# syntax=docker/dockerfile:1
#
# Multi-stage build for @karyl-chan/plugin-reminder inside the pnpm
# monorepo.
#
# IMPORTANT: the build context MUST be the karyl-chan monorepo root so
# pnpm-workspace.yaml, pnpm-lock.yaml, and sibling workspace packages
# (@karyl-chan/plugin-sdk) are visible. The compose file at
# docker-compose.plugins.yml sets:
#   context: ./karyl-chan
#   dockerfile: packages/plugin-reminder/Dockerfile

FROM node:22-bullseye-slim AS base
RUN corepack enable
WORKDIR /repo
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/plugin-sdk/package.json packages/plugin-sdk/
COPY packages/plugin-reminder/package.json packages/plugin-reminder/


FROM base AS build
RUN pnpm install --frozen-lockfile --filter @karyl-chan/plugin-reminder...
COPY packages/plugin-sdk packages/plugin-sdk
COPY packages/plugin-reminder packages/plugin-reminder
RUN pnpm --filter @karyl-chan/plugin-sdk build \
    && pnpm --filter @karyl-chan/plugin-reminder build
RUN pnpm --filter @karyl-chan/plugin-reminder deploy --legacy --prod /app


FROM node:22-bullseye-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
USER node
EXPOSE 3000
CMD ["node", "dist/index.js"]

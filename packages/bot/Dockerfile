# syntax=docker/dockerfile:1
#
# Multi-stage build for @karyl-chan/bot inside the pnpm monorepo.
#
# IMPORTANT: the build context MUST be the monorepo root so the pnpm
# workspace files (pnpm-workspace.yaml / pnpm-lock.yaml) and sibling
# package manifests are visible. docker-compose.yml and the CI workflow
# both set `context: <repo root>, dockerfile: packages/bot/Dockerfile`.

# Base: Debian 11 (bullseye) ships glibc 2.31, which matches the
# `linux-{amd64,arm64}-glibc-2.31` prebuilt tarballs that @discordjs/opus
# publishes on GitHub releases. Newer bases (bookworm 2.36 / trixie 2.41)
# have no matching prebuilt → node-pre-gyp falls back to source build,
# which fails on arm64 due to a known bug in opus's bundled NEON
# intrinsics (celt_inner_prod_neon used without declaration). Bullseye
# LTS support runs to 2026-08; revisit base + encoder choice before then.
FROM node:22-bullseye-slim AS base
RUN corepack enable
WORKDIR /repo
# Workspace + package manifests only. Copied before the source tree so
# the `pnpm install` layer stays cached when only app code changes.
# All workspace manifests are required — pnpm validates the lockfile
# against the whole workspace even with --filter.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json .npmrc ./
COPY packages/bot/package.json packages/bot/
COPY packages/bot/frontend/package.json packages/bot/frontend/
COPY packages/plugin-sdk/package.json packages/plugin-sdk/
COPY packages/ui/package.json packages/ui/


FROM base AS frontend-build
# --filter ...^ resolves workspace deps transitively (karyl-chan-frontend
# now depends on @karyl-chan/ui via workspace:*).
RUN pnpm install --frozen-lockfile --filter karyl-chan-frontend...
COPY packages/ui packages/ui
COPY packages/bot/frontend packages/bot/frontend
RUN pnpm --filter karyl-chan-frontend build


FROM base AS backend-build
# Build toolchain for sqlite3's source build. .npmrc pins
# `build_from_source=sqlite3` — sqlite3's prebuilt links GLIBC_2.38
# which neither bullseye (2.31) nor the WSL dev box (2.35) can load,
# so it has to compile against the host glibc. @discordjs/opus gets
# its arm64/amd64 glibc-2.31 prebuilt and skips compilation entirely
# (its source build is broken on arm64 — see base stage comment).
# This stage is discarded; only the deployed bundle below is copied
# into the runtime image.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
RUN pnpm install --frozen-lockfile --filter @karyl-chan/bot
COPY packages/bot packages/bot
RUN pnpm --filter @karyl-chan/bot build
# Flatten the bot + its production dependencies into a self-contained
# bundle. `pnpm deploy` resolves the workspace's symlinked node_modules
# into a real tree that can be copied verbatim into the runtime image.
# --legacy: pnpm 10 otherwise refuses to deploy a non-injected
# workspace; the bot has no workspace-package dependencies, so the
# legacy hard-copy behaviour is exactly what is wanted here.
RUN pnpm --filter @karyl-chan/bot deploy --legacy --prod /app


FROM node:22-bullseye-slim AS runtime

WORKDIR /usr/src/app

# ffmpeg is required by @discordjs/voice for audio decoding. We use
# the apt package rather than the ffmpeg-static npm binary; prism-media
# discovers it via PATH. bullseye ships ffmpeg 4.3, which covers all
# opus codec paths the bot uses. --no-install-recommends keeps the
# image slim (~80MB vs 200MB).
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    SQLITE_DB_PATH=/usr/src/app/data/database.sqlite \
    WEB_PORT=3000

EXPOSE 3000

# The deploy bundle already carries a real, production-only node_modules
# (native modules compiled in the backend-build stage above, against
# this same Trixie glibc) plus the compiled build/ output.
COPY --from=backend-build /app/package.json ./package.json
COPY --from=backend-build /app/node_modules ./node_modules
COPY --from=backend-build /app/build ./build
COPY --from=frontend-build /repo/packages/bot/frontend/dist ./build/public

RUN mkdir -p /usr/src/app/data && chown -R node:node /usr/src/app

USER node

VOLUME ["/usr/src/app/data"]

CMD [ "node", "build/main.js" ]

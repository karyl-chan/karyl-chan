# syntax=docker/dockerfile:1
#
# Multi-stage build for @karyl-chan/voice (the standalone voice service)
# inside the pnpm monorepo.
#
# IMPORTANT: the build context MUST be the monorepo root so the pnpm
# workspace files (pnpm-workspace.yaml / pnpm-lock.yaml) and sibling package
# manifests are visible. compose / CI set
# `context: <repo root>, dockerfile: packages/voice/Dockerfile`.

# Base: Debian 11 (bullseye) ships glibc 2.31, matching the
# `linux-{amd64,arm64}-glibc-2.31` prebuilt tarballs @discordjs/opus publishes
# (same rationale as the bot image — newer bases have no matching prebuilt and
# opus's source build is broken on arm64). NO sqlite here: the voice service is
# stateless (in-memory per-guild connections only).
FROM node:22-bullseye-slim AS base
RUN corepack enable
WORKDIR /repo
# Workspace + package manifests only (cached install layer). The voice service
# depends on @karyl-chan/plugin-sdk (HMAC), so that manifest is required too.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json .npmrc ./
COPY packages/voice/package.json packages/voice/
COPY packages/plugin-sdk/package.json packages/plugin-sdk/


FROM base AS build
# Toolchain only for @discordjs/opus's node-pre-gyp (it fetches the glibc-2.31
# prebuilt and skips compilation; python/make/g++ are the safety net). No
# sqlite source build needed.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
# --filter ...^ resolves the workspace dep (plugin-sdk) transitively.
RUN pnpm install --frozen-lockfile --filter @karyl-chan/voice...
COPY packages/plugin-sdk packages/plugin-sdk
COPY packages/voice packages/voice
# plugin-sdk must be built first (voice imports its dist).
RUN pnpm --filter @karyl-chan/plugin-sdk build
RUN pnpm --filter @karyl-chan/voice build
# Flatten voice + its production deps into a self-contained bundle. --legacy:
# pnpm hard-copies the workspace dep (plugin-sdk) into the deploy tree.
RUN pnpm --filter @karyl-chan/voice deploy --legacy --prod /app


FROM node:22-bullseye-slim AS runtime

WORKDIR /usr/src/app

# ffmpeg is required by @discordjs/voice for audio decoding; prism-media
# discovers it via PATH (we don't ship ffmpeg-static). bullseye ships ffmpeg
# 4.3, covering all opus paths the service uses.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    VOICE_PORT=4000 \
    VOICE_HOST=0.0.0.0

EXPOSE 4000

# The deploy bundle carries a real, production-only node_modules (opus
# compiled against this same bullseye glibc) plus the compiled dist/ output.
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

RUN chown -R node:node /usr/src/app
USER node

CMD [ "node", "dist/main.js" ]

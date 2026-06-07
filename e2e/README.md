# karyl-chan cross-service E2E + chaos harness (PR-6.2 / PR-6.3)

This directory holds the cross-service integration smoke (E2E) and the
fault-injection (chaos) harness. It is a pnpm workspace member **only**
so `pnpm install` resolves its devDeps — it exposes **no `test` script**,
so the normal `pnpm test` / `pnpm -r test` never runs it. Every scenario
is additionally **env-gated** and skips/no-ops when its flag is unset, so
nothing here can turn the default CI run red.

> Status as shipped in PR-6: the harness is **correct, gated, and
> documented but NOT executed in CI** — the sandbox where it was authored
> has no Docker/Redis. Run it locally (or wire it into a dedicated,
> services-up CI lane) per the steps below.

## Layout

| File | Flag (gate) | What it proves |
|---|---|---|
| `src/streams-roundtrip.e2e.ts` | `TEST_E2E_REDIS_URL` | Real event round-trip: bot `RedisStreamsPluginEventBus` producer → real Redis → SDK `StreamsConsumer` → handler → `XACK`. Producer/consumer agree on stream key, fields, ack semantics against a live broker. |
| `src/chaos-scenarios.chaos.ts` | `TEST_CHAOS=1` | Fault-injection scaffold: kill plugin, kill Redis, network partition, gateway resume window. Scenarios are declared + the runner is wired; the actual fault-injection steps are documented TODOs pending a services-up lane. |

## Prerequisites

The harness imports the two services' **compiled** output, so build them
first:

```sh
pnpm --filter @karyl-chan/plugin-sdk build
pnpm --filter @karyl-chan/bot build
```

## Run the E2E smoke

```sh
# 1. bring up Redis
docker compose -f e2e/docker-compose.e2e.yml up -d redis

# 2. run the gated smoke
TEST_E2E_REDIS_URL=redis://localhost:6390 pnpm --dir e2e e2e

# 3. tear down
docker compose -f e2e/docker-compose.e2e.yml down -v
```

Without `TEST_E2E_REDIS_URL` the suite reports `# SKIP` and exits 0.

### Fuller topology (bot + plugin + Postgres)

The compose file also scaffolds `postgres` and a Discord-less `bot`
(`BOT_SKIP_DISCORD=true`) behind the `full` profile, for the RPC / WebUI
round-trip and the chaos scenarios that need a running bot:

```sh
docker compose -f e2e/docker-compose.e2e.yml --profile full up -d --build
```

## Run the chaos scenarios

```sh
docker compose -f e2e/docker-compose.e2e.yml --profile full up -d --build
TEST_CHAOS=1 pnpm --dir e2e chaos
docker compose -f e2e/docker-compose.e2e.yml down -v
```

See `src/chaos-scenarios.chaos.ts` for the scenario catalogue and the
expected self-recovery invariant each one asserts.

## Why a separate harness (not inside packages/bot/tests)

- The bot package builds **without** declaration files, so a static
  cross-package import would leave `tsc` typeless; the harness uses
  dynamic `import()` with local structural types instead.
- E2E/chaos need **real** services and meaningful wall-clock time; keeping
  them out of the unit suite preserves the "`pnpm test` is fast and needs
  no external services" invariant the rest of the repo relies on.

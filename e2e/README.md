# karyl-chan cross-service E2E + chaos harness (PR-6.2 / PR-6.3)

This directory holds the cross-service integration and fault-injection
harness. Package unit tests remain service-free, while the dedicated,
required `plugin-platform-e2e` CI job runs this harness against real
Postgres and Redis on every pull request and push to `main`.

Individual files remain env-gated for focused local work. CI invokes the
`required` runner, which validates all gates, runs every path separately,
requires its expected suite marker and at least one passing test, and fails
on any TAP `SKIP` or `TODO` annotation. A missing/no-op scenario therefore
cannot make the required job green.

## Layout

| File                               | Flag (gate)                              | What it proves                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---------------------------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/streams-roundtrip.e2e.ts`     | `TEST_E2E_REDIS_URL`                     | Real event round-trip: bot `RedisStreamsPluginEventBus` producer → real Redis → SDK `StreamsConsumer` → handler → `XACK`. Producer/consumer agree on stream key, fields, ack semantics against a live broker.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `src/plugin-lifecycle.e2e.ts`      | `TEST_E2E_DB_URL` (Postgres URL)         | **PM-2.1 core path 3 + #65** — the whole external-author journey over real HTTP: spawned bot (`BOT_SKIP_DISCORD`) → setup secret → SDK register/readiness → command sync → admin enable → plugin-token RPC → HMAC dispatch → bot-side KV → graceful deregister. It also proves initialization refuses dispatch and a throwing `onStart` never becomes ready.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `src/admin-dashboard.e2e.ts`       | `TEST_E2E_DB_URL` (Postgres URL)         | **PM-2.2 core paths 1+2** — REAL-auth bot (`BOT_OWNER_IDS` set): anonymous/garbage Bearer → 401; the harness decrypts the bot's persisted Ed25519 signing key from `jwt_signing_keys` (it owns the same Postgres + `ENCRYPTION_KEY`) and mints the `purpose: login` JWT the admin-login behavior would → `/api/auth/exchange` (non-owner JWT rejected at stage 2) → Bearer dashboard reads → refresh rotation (old refresh token single-use) → logout revokes both tokens. Path 2: builtin feature toggle (`PUT /api/bot-features/state/:key`) per-guild + operator default + disable round-trip + unknown key → 404 — persisted state must not depend on Discord availability.                                                                                                                                                                    |
| `src/behavior-and-dm.e2e.ts`       | `TEST_E2E_DB_URL` (Postgres URL)         | **PM-2.3 core paths 4+5** — dev-bypass bot + `WEBHOOK_ALLOW_PRIVATE=true`; webhook sink bound on the host's non-loopback private IPv4 (loopback is denied unconditionally by host policy). Path 4 via `POST /api/behaviors/:id/test` (the same `WebhookForwarder.forward` the slash path uses): none-mode header hygiene, token-mode shared-secret header, hmac-mode request signature verified sink-side (`POST:<path>:<ts>:<nonce>:<body>`), signed-response requirement (unsigned response in hmac mode → fail closed), `[BEHAVIOR:END]` sets `ended` + strips the sentinel. Path 5 via the dev-only `POST /api/dm/dev/inject-message` seam (live only under the unauth bypass): synthetic DM → real `recordActivity` → event bus → live SSE frames on `/api/dm/events` → channel listed → admin reply degrades to a clean 404 without Discord. |
| `src/transport-negotiation.e2e.ts` | `TEST_E2E_DB_URL` + `TEST_E2E_REDIS_URL` | **#66** — a matching bot-selected Streams transport reaches the SDK handler and `XACK`s; a Plugin that only offers HTTP is rejected by a Streams Bot and remains not-ready with actionable Admin state.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `src/chaos-scenarios.chaos.ts`     | `TEST_CHAOS=1` + Postgres/Redis URLs     | **#67 recovery invariants** — `SIGKILL`ed Plugin replicas are reaped and recover on restart; an event left pending by a killed Streams consumer is reclaimed and acknowledged by its replacement without entering DLQ. Network partition and Discord gateway resume remain explicit non-goals, not TODO tests.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

## Prerequisites

The harness imports the services' **compiled** output. All run scripts build
the current plugin-wire, packaged SDK, SDK internal consumer, bot, and E2E
sources first, so a stale generated artifact cannot make the gate pass.

## Run the required gate locally

Start only the two external services; the tests spawn their own Discord-less
bot and Plugin processes:

```sh
docker compose -f e2e/docker-compose.e2e.yml --profile full up -d redis postgres
```

POSIX shell:

```sh
TEST_E2E_REQUIRED=1 \
TEST_CHAOS=1 \
TEST_E2E_REDIS_URL=redis://127.0.0.1:6390 \
TEST_E2E_DB_URL=postgres://postgres:e2e@127.0.0.1:55433/karyl_e2e \
pnpm --dir e2e required
```

PowerShell:

```powershell
$env:TEST_E2E_REQUIRED = "1"
$env:TEST_CHAOS = "1"
$env:TEST_E2E_REDIS_URL = "redis://127.0.0.1:6390"
$env:TEST_E2E_DB_URL = "postgres://postgres:e2e@127.0.0.1:55433/karyl_e2e"
pnpm --dir e2e required
```

Clean up with `docker compose -f e2e/docker-compose.e2e.yml --profile full down`.

To prepare compiled artifacts separately while debugging:

```sh
pnpm --dir e2e build:required
```

## Run the E2E smoke

```sh
# 1. bring up Redis
docker compose -f e2e/docker-compose.e2e.yml up -d redis

# 2. run the gated smoke
TEST_E2E_REDIS_URL=redis://localhost:6390 pnpm --dir e2e e2e

# 3. tear down
docker compose -f e2e/docker-compose.e2e.yml down
```

Without `TEST_E2E_REDIS_URL` the focused suite reports `# SKIP` and exits 0.
The `required` runner instead fails before launch when any gate is missing.

### Fuller topology (bot + plugin + Postgres)

The compose file also scaffolds `postgres` and a Discord-less `bot`
(`BOT_SKIP_DISCORD=true`) behind the `full` profile, for the RPC / WebUI
round-trip and the chaos scenarios that need a running bot:

```sh
docker compose -f e2e/docker-compose.e2e.yml --profile full up -d --build
```

## Run only the chaos scenarios

```sh
docker compose -f e2e/docker-compose.e2e.yml --profile full up -d redis postgres
TEST_CHAOS=1 TEST_E2E_REDIS_URL=redis://127.0.0.1:6390 TEST_E2E_DB_URL=postgres://postgres:e2e@127.0.0.1:55433/karyl_e2e pnpm --dir e2e chaos
docker compose -f e2e/docker-compose.e2e.yml --profile full down
```

See `src/chaos-scenarios.chaos.ts` for the two executable recovery invariants.

## Why a separate harness (not inside packages/bot/tests)

- The bot package builds **without** declaration files, so a static
  cross-package import would leave `tsc` typeless; the harness uses
  dynamic `import()` with local structural types instead.
- E2E/chaos need **real** services and meaningful wall-clock time; keeping
  them out of the unit suite preserves the "`pnpm test` is fast and needs
  no external services" invariant the rest of the repo relies on.

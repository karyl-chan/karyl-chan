# Adapters

Forward-looking abstraction layer between the bot core and the
external stores it relies on. Each adapter file defines an
**interface** and ships an **`InProcess*` default implementation**.

The default implementations preserve the current single-host behaviour
(in-memory Maps, the existing SQLite-backed `db.ts`) so a fresh
`docker compose up` keeps working with zero external dependencies.
[Phase 1+ of `SCALING_PLAN.md`](../../../../../SCALING_PLAN.md) plugs
in Redis / Postgres implementations behind the same interfaces via
environment variables, without touching call sites.

## Adapters

| File | Interface | InProcess default | Phase 1+ swap target |
|------|-----------|-------------------|----------------------|
| `db-driver.ts` | `DbDriver` | the existing `db.ts` Sequelize instance | Postgres (Phase 2.1) |
| `session-store.ts` | `SessionStore` | the existing `AuthStore` class | Redis (Phase 1.1) |
| `plugin-metrics-store.ts` | `PluginMetricsStore` | `InProcessPluginMetricsStore` (Map) | Redis hash (Phase 1.3) |
| `plugin-health-store.ts` | `PluginHealthStore` | `InProcessPluginHealthStore` (Map) | Redis hash (Phase 1.3) |
| `plugin-event-bus.ts` | `PluginEventBus` | `InProcessPluginEventBus` (HTTP fan-out — current behaviour) | Redis Streams (Phase 2.2) |
| `rate-limit-store.ts` | `RateLimitStoreFactory` | `null` (lets `@fastify/rate-limit` use its built-in in-memory store) | Redis (Phase 1.2) |
| `voice-state-store.ts` | `VoiceStateStore` | the existing `voice-manager.service.ts` Map | Redis hash (Phase 1+, optional) |
| `distributed-lock.ts` | `DistributedLock` | `InProcessDistributedLock` (single-process mutex) | Redis SETNX (Phase 1.4) |

## Boot-time selection

`adapters/registry.ts` exposes one factory per adapter that picks the
implementation by env var, defaulting to the in-process variant when
unset. The rest of the bot reads adapters through the registry so
swapping implementations is a single point of edit (and a single
container env diff in production).

## Adding an adapter

1. Define `interface Foo` in `foo.ts`.
2. Add `class InProcessFoo implements Foo` next to it. Keep it small;
   the goal is to preserve current behaviour, not to add features.
3. Update `registry.ts` with a `getFoo()` factory.
4. Migrate one call site to `getFoo()` to prove the interface fits.
5. Other call sites migrate opportunistically — the InProcess default
   stays a static export so existing imports keep working until they're
   touched naturally.

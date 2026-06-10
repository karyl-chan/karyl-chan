# Architecture guide

## Why this slicing

The bot is three things in one process:

1. **Discord client** — handles gateway events and runs slash commands.
2. **HTTP API** — backs the admin web panel.
3. **Plugin host** — talks to external plugin processes over RPC.

The pre-refactor layout split by **layer** (`commands/` / `events/` /
`models/` / `services/` / `web/`), so adding a feature meant touching
seven files across five directories. The current layout splits by
**business concept** instead: each module is self-contained.

> Design rule: **vertical slicing (by feature) first, horizontal slicing
> (by layer) second.** All facets of a concept (Discord events, slash
> commands, HTTP routes, DB model) live together; things of the same
> kind (all routes, all models) being scattered across modules is fine.

---

## Directory map

```
src/
├── db.ts                       # Sequelize singleton (used by every module)
├── main.ts                     # entry point — boot, sync, register, startWebServer
├── config.ts                   # env vars → typed config (frozen on export)
├── config-metadata.ts          # config-field metadata (used by the admin settings page)
├── logger.ts                   # pino logger + moduleLogger() factory
├── bootstrap-events.ts         # central registration of every Discord event
├── bootstrap-in-process.ts     # central registration of every in-process slash command
├── types/                      # ambient .d.ts (rcon.d.ts)
├── utils/                      # pure-function utilities (crypto / hmac / host-policy / rate-limiter / ...)
└── modules/                    # business modules (11)
    ├── plugin-system/          # external RPC plugin lifecycle
    ├── behavior/               # behaviors — "Discord trigger → action" rules
    ├── command-system/         # slash command reconcile + interaction dispatch + DM pattern
    ├── builtin-features/       # in-process Discord features (5 subdirectories)
    │   ├── picture-only/
    │   ├── rcon-forward/
    │   ├── role-emoji/
    │   ├── todo-channel/
    │   ├── voice/
    │   ├── guild-builtin.service.ts                # per-guild builtin-feature toggle aggregator
    │   └── in-process-command-registry.service.ts  # shared in-process command / modal registry
    ├── feature-toggle/         # unified feature on/off state
    ├── voice/                  # voice connection manager + voice RPC (for plugins)
    ├── admin/                  # admin identity, login, capabilities, audit
    ├── dm-inbox/               # DM inbox + SSE push
    ├── guild-management/       # Discord guild management web API
    ├── bot-events/             # bot event log (voice transitions, structured errors)
    └── web-core/               # Fastify infrastructure + JWT signing authority + bot-wide meta endpoints
```

> DB schema is defined by each module's `models/`; at startup
> `sequelize.sync()` **creates** missing tables, then an Umzug-backed
> migration runner (`src/db-migrations.ts`, `runMigrations()` in `main.ts`)
> applies incremental schema changes from `src/migrations/NNN-*.ts` (tracked
> in `SequelizeMeta`). Schema-evolution caveats are in
> [`operations.md`](operations.md#schema-changes-on-upgrade).

---

## Module responsibilities

### `modules/plugin-system/` — external RPC plugins

**What it does.** A plugin is an **independent process**. The bot talks
to it over HTTP RPC; each plugin gets its own randomly-generated
`dispatchHmacKey` (returned once at registration, stored on the plugin row)
that signs bot→plugin event dispatch. This module handles plugin
registration, heartbeats, token management, event dispatch, command
sync, interaction and component routing, bidirectional RPC, and the
WebUI reverse proxy.

**Key files.**
- `plugin-registry.service.ts` — manifest validation, two-stage token
  handshake, heartbeat reaper.
- `plugin-event-bridge.service.ts` — `eventType → Set<pluginId>` index
  and dispatch.
- `plugin-command-registry.service.ts` — manifest commands → Discord
  application commands.
- `plugin-interaction-dispatch.service.ts` /
  `plugin-component-dispatch.service.ts` — Discord interaction / button
  → POST to plugin.
- `plugin-auth.service.ts` — in-memory token hash cache.
- `plugin-proxy.ts` — `/plugin/<key>/*` WebUI reverse proxy.
- `plugin-routes.ts` — `/api/plugins/*` (register, heartbeat, admin).
- `plugin-rpc-routes.ts` — `/api/plugin/*` (plugin → bot RPC).
- `models/` — plugin, plugin-capability, plugin-command, plugin-config,
  plugin-kv.

**External surface.** HTTP `/api/plugins/*`, `/api/plugin/*`,
`/plugin/*`; `pluginRegistry`, `dispatchEventToPlugins`.

**Depends on.** web-core; feature-toggle (plugin-guild-feature state);
voice (voice RPC backend).

---

### `modules/behavior/` — behaviors

**What it does.** A behavior is a "Discord trigger → action" rule.
Triggers are `slash_command` or `message_pattern`; sources are `custom`
(webhook forward) or `system` (built-in handler). All behaviors share
one `behaviors` table, attached to a scope tab. See
[`features/behaviors.md`](features/behaviors.md).

**Key files.**
- `behavior-routes.ts` — `/api/behaviors/*` CRUD + resync.
- `scope-tab-routes.ts` — `/api/behavior-tabs/*` CRUD.
- `behavior-helpers.ts` — shared helpers (profile, decrypted view,
  permission).
- `behavior-trigger.ts` — pure `matchesTrigger` / `describeTrigger`.
- `system-seed.service.ts` — idempotent seed of the three system
  behaviors (login / manual / break).
- `scope-tab-seed.service.ts` — idempotent seed of the four fixed scope
  tabs.
- `models/` — behavior, behavior-scope-tab, behavior-audience-member,
  behavior-session.

**External surface.** HTTP `/api/behaviors/*`, `/api/behavior-tabs/*`;
`ensureSystemBehaviors` and `ensureFixedScopeTabs` (called by `main.ts`
at startup).

**Depends on.** web-core; admin (audit + capability).

> Behavior **dispatch** (trigger → action) lives in `command-system`,
> not here. This module is only the rule store and CRUD.

---

### `modules/command-system/` — command sync + interaction dispatch

**What it does.** Reconciles `behaviors` (track 2) and `plugin_commands`
(track 3) into Discord application commands at runtime, dispatches all
interactions, and matches DM patterns. This is the bot's command
backbone.

**Key files.**
- `reconcile.service.ts` — `CommandReconciler`: compute the desired
  set, diff against Discord's current state, create / patch / delete.
  `reconciler_owned_commands` records which commands the reconciler
  owns so it cannot mistakenly delete track-1 in-process commands.
- `interaction-dispatcher.service.ts` — `InteractionDispatcher`:
  unified `interactionCreate` entry; in order, tries behaviors slash,
  plugin command, plugin component, then in-process command.
- `message-pattern-matcher.service.ts` — `MessagePatternMatcher`: DM
  `messageCreate` listener that handles `message_pattern` triggers and
  continuous sessions.
- `webhook-forwarder.service.ts` — `WebhookForwarder`: webhook POST +
  HMAC signing and verification + `[BEHAVIOR:END]` detection.
- `models/reconciler-owned-command.model.ts` — reconciler's command
  ownership ledger.

**External surface.** `CommandReconciler`, `InteractionDispatcher`,
`MessagePatternMatcher`, `WebhookForwarder` (all instantiated and wired
by `main.ts`).

**Depends on.** behavior (reads `behaviors`); plugin-system (reads
`plugin_commands`, dispatches plugin interactions); admin; web-core.

---

### `modules/builtin-features/` — in-process Discord features

**What it does.** Discord features the bot ships natively. Each lives
in its own subdirectory with commands + events + model + routes. The
shared `in-process-command-registry.service.ts` manages slash command
and modal routing.

**Five subdirectories.**

| Subdirectory | Purpose |
|--------------|---------|
| `picture-only/` | Restrict a channel to attachment-bearing messages. |
| `rcon-forward/` | Forward channel messages to a game server's RCON. |
| `role-emoji/` | Grant / revoke roles based on reactions. |
| `todo-channel/` | Use a channel as a todo list. |
| `voice/` | `/voice` voice connection control. |

**Standard subdirectory layout.** `{name}.commands.ts`,
`{name}.events.ts`, `{name}.model.ts`, `routes.ts`, optional
`*helpers.ts`. `voice/` is the simplest — only `voice.commands.ts` —
because the connection manager lives in the separate `modules/voice/`
module.

**External surface.** Discord slash commands and reaction handlers,
`/api/guilds/:guildId/feature/{name}*`.

**Depends on.** web-core; feature-toggle (feature on/off check);
guild-management (type import only); bot-events; voice (the voice
feature).

---

### `modules/feature-toggle/` — unified feature toggle state

**What it does.** Owns "**who turned what on**", not how the feature
works. Covers two tracks:

- **Plugin guild features** — per-guild sub-features inside plugins.
- **Built-in features** — per-guild toggle for the bot's built-in
  features.

Resolution chain for plugin features:
per-guild state → operator default → manifest `enabled_by_default` →
`false`.

**Key files.**
- `bot-feature-routes.ts` — built-in feature toggle CRUD.
- `models/` — plugin-guild-feature, plugin-feature-default,
  bot-feature-state.

**External surface.** HTTP `/api/bot-features/*`; query helpers on each
model.

**Depends on.** web-core; admin.

---

### `modules/voice/` — voice backend seam

**What it does.** The actual per-guild connection manager (one
`VoiceConnection` per guild; join/leave/play/pause/stop/status; playback via
`@discordjs/voice` + ffmpeg) now lives in the standalone `@karyl-chan/voice`
package (`packages/voice/src/voice-manager.ts`). This bot module is the seam
that selects a `VoiceBackend`: `InProcessVoiceBackend` (default, drives the
voice manager in-process) or `RemoteVoiceBackend` (forwards to an external
voice service at `VOICE_SERVICE_URL`, signed with `VOICE_HMAC_SECRET`). Slash
commands (`builtin-features/voice/`) and plugin RPC both go through the
selected backend, so per-guild state stays consistent.

**Key files.**
- `voice-backend.ts` — `VoiceBackend` interface + in-process backend + `getVoiceBackend()`.
- `remote-voice-backend.ts` — HTTP client for the external voice service.
- `voice-internal-routes.ts`, `voice-gateway-relay.ts` — bot↔voice-service bridge (gateway-send is restricted to OP4 voice-state-update).
- `voice-rpc.ts` — plugin → bot voice RPC entry point.

**External surface.** `getVoiceBackend()` / `setVoiceClient()`; the
`VoiceBackend` interface (`join`/`leave`/`play`/`pause`/`stop`/`status`/`shutdown`);
voice RPC handler.

**Depends on.** utils, config, logger (intentionally no dependency on
business modules).

---

### `modules/admin/` — admin identity

**What it does.** An admin is a Discord user authorised to log into
the web panel. This module covers admin lifecycle, login, capability
tokens, and the audit log (with hash chain).

**Key files.**
- `admin-login.service.ts` — login link issuance and exchange.
- `admin-management-routes.ts`, `admin-login-status-routes.ts`,
  `admin-system-settings-routes.ts` — admin and system settings web
  API.
- `admin-audit.service.ts` — audit log writes; canonical payload +
  hash chain.
- `authorized-user.service.ts` — Discord user → admin mapping.
- `admin-capabilities.ts` — capability enumeration + token builders/parsers
  (`GLOBAL_CAPABILITY_DESCRIPTIONS`, `GUILD_SCOPES`, `DEFAULT_ROLES`,
  `makeGuildScopedCapability`, …). The `requireCapability` /
  `requireGuildCapability` route guards live in `web-core/route-guards.ts`.
- `models/` — admin-audit-log, admin-role, admin-role-capability,
  authorized-user.

**External surface.** HTTP `/api/admin/*`, `/api/auth/*`;
`requireCapability` family; `recordAudit`.

**Depends on.** web-core; bot-events.

---

### `modules/dm-inbox/` — DM inbox

**What it does.** DMs the bot receives appear in the admin web
panel's inbox; admins reply directly from the panel. Provides SSE
push for live updates.

**Key files.**
- `dm-routes.ts` — `/api/dm/*` list / fetch / send / SSE.
- `dm-inbox.service.ts` — DM storage and retrieval.
- `dm-event-bus.ts` — in-memory pub/sub SSE bus.
- `events/dm-inbox.events.ts` / `events/typing-start.events.ts`.
- `models/dm-channel.model.ts`.

**External surface.** HTTP `/api/dm/*`; `dmEventBus`.

**Depends on.** web-core, admin, guild-management, bot-events.

---

### `modules/guild-management/` — Discord guild management

**What it does.** Lets admins manage Discord guilds from the web
panel: list guilds, view channels, edit roles, edit settings, view
messages, automod rules, and so on.

**Key files.**
- `guild-management-routes.ts` — facade; registers every sub-routes
  file (including the five builtin-features routes).
- `guilds-routes.ts`, `guild-member-routes.ts`,
  `guild-message-routes.ts`, `guild-role-routes.ts`,
  `guild-settings-routes.ts`, `guild-automod-routes.ts`,
  `guild-channel-routes.ts`, `guild-channel-mgmt-routes.ts`.
- `guild-management-shared.ts` — shared helpers
  (`GuildManagementRoutesOptions`).
- `guild-channel-event-bus.ts` + `events/guild-channel.events.ts` —
  guild channel SSE.

**External surface.** HTTP `/api/guilds/*`; `guildChannelEventBus`;
`GuildManagementRoutesOptions`.

**Depends on.** web-core, admin, builtin-features (facade registers
their routes).

---

### `modules/bot-events/` — bot event log

**What it does.** Structured logging of bot behaviour — voice
transitions, warns and errors, admin actions. Lets admins see what
the bot is doing from the web panel.

**Key files.**
- `bot-event-routes.ts` — `/api/bot-events/*` query.
- `bot-event-log.ts` — `botEventLog(...)` fire-and-forget writer.
- `bot-event-dedup.ts` — in-memory `shouldRecord(key, ttl)` dedup.
- `events/voice-state.events.ts` — Discord `voiceStateUpdate` → log.
- `models/bot-event.model.ts`.

**External surface.** HTTP `/api/bot-events/*`; `botEventLog`,
`shouldRecord`.

**Depends on.** web-core.

---

### `modules/web-core/` — Fastify infrastructure + bot-wide meta

**What it does.** HTTP-layer infrastructure (server bootstrap, JWT
signing authority, token store, route-guards, shared DTOs, readiness),
plus cross-cutting meta routes.

**Key files.**
- `server.ts` — Fastify entry; the **central registration point** for
  every module's routes.
- `jwt.service.ts` + `models/jwt-signing-key.model.ts` — Ed25519 JWT
  signing. Admin/session tokens use the master key; plugin-session tokens
  are signed with a **per-plugin** key derived via HKDF from the master
  seed + plugin key, so a token minted for one plugin can't verify against
  another.
- `auth-store.service.ts` + `refresh-token.repository.ts` +
  `models/refresh-token.model.ts` — token storage.
- `route-guards.ts` — `requireAnyCapability` / `requireGuildCapability`
  and similar middleware.
- `validators.ts` — `isSnowflake`, `isBoundedString`, and so on (pure
  functions).
- `message-mapper.ts` + `message-types.ts` — Discord message → API DTO.
- `readiness.ts` — `db` and `bot` readiness signals.
- `system-routes.ts` — `/api/health/*`, `/api/system/*`.
- `discord-routes.ts` — `/api/discord/*` cross-guild resource lookups.
- `sse-helper.ts`, `metrics.ts`.

**External surface.** `startWebServer`; `requireCapability` family;
`isSnowflake` family; `toApiMessage`; `getReadiness` / `setReady`.

**Depends on.** admin (route-guards uses capability); every other
module (server.ts registers their routes).

---

## Dependency rules

### Allowed

```
any module → web-core / utils / db.ts / config / logger     OK
admin → bot-events                                           OK   (admin actions write log)
behavior → admin                                             OK   (audit + capability)
command-system → behavior / plugin-system                    OK   (reads rules, dispatches)
plugin-system → feature-toggle / voice                       OK
builtin-features → feature-toggle / bot-events / voice        OK
builtin-features ↔ guild-management                           OK   (facade; builtin imports type only)
dm-inbox → admin / guild-management / bot-events              OK
```

### Forbidden

```
web-core → any business module
  Reason: web-core is infrastructure and is depended on by every
  module. The only exception is server.ts (the entry point), which
  may import every routes file in order to register them.

Runtime cycles between business modules
  guild-management ↔ builtin-features is a known tension (facade
  design); builtin-features imports a type only, with no runtime edge.

New modules created on a whim
  Each new modules/X/ must answer: what concept does X live at?
```

### Import paths

- ESM + NodeNext. Every relative import **must include the `.js`
  extension**.
- Same module: `./Y.js` or `./subdir/Y.js`.
- Across modules: `../<other>/Y.js` (or `../../<other>/Y.js` from a
  subdirectory).
- To shared layers: `../../utils/Y.js`, `../../db.js`,
  `../../config.js` (depth adjusted per module).

---

## Shared layer

| Path | Contents | Rule |
|------|----------|------|
| `src/db.ts` | Sequelize singleton | Imported directly by any module. |
| `src/config.ts` | Typed config (frozen) | Imported by any module; environment variables are documented in `.env.example`. |
| `src/logger.ts` | pino logger | Call `moduleLogger("name")` for a module-tagged logger. |
| `src/utils/` | Pure-function utilities | **No dependency on any business module.** Importable from anywhere. |
| `src/types/` | Ambient `.d.ts` | Included by tsconfig; no import needed. |
| `src/bootstrap-events.ts` | Discord event registration | Every `events/X.events.ts` is wired here. |
| `src/bootstrap-in-process.ts` | In-process slash command registration | Same pattern as events. |
| `src/main.ts` | Entry — boot, `sequelize.sync()`, seed, register, startWebServer | Pure wiring; no business logic. |

---

## Deciding where new code goes

### Q1 — what kind of thing is it

```
A "set up / manage" action on the admin web panel?     → Q2
A bot action triggered by a Discord user?              → Q2
Something a plugin process does (separate binary)?     → Update plugin manifest; nothing in the bot.
A cross-cutting utility / Discord lookup?              → web-core/discord-routes or system-routes.
A pure-function utility?                               → src/utils/.
```

### Q2 — which existing module

| Want to do | Goes in |
|------------|---------|
| A new "Discord trigger → action" rule | `behavior/` (plus possibly `command-system/`'s dispatch). |
| A new in-process Discord feature (like picture-only) | `builtin-features/<name>/`. |
| A new feature toggle behaviour | `feature-toggle/`. |
| A new admin management surface | `admin/` — service + routes. |
| A new DM inbox feature | `dm-inbox/`. |
| A new guild management endpoint | `guild-management/` — find the right routes file. |
| A new bot event category to log | `bot-events/`. |

Create a new module only when no existing module fits.

---

## Adding a new builtin feature (full SOP)

To add, for example, a `slow-mode-channel` feature similar to
`picture-only`:

```
1. Create src/modules/builtin-features/slow-mode/.
2. Copy picture-only/'s four files for the skeleton:
   - slow-mode.commands.ts   # /slow-mode set / unset
   - slow-mode.events.ts     # messageCreate handler
   - slow-mode.model.ts      # SlowModeChannel(channelId, guildId, intervalMs)
   - routes.ts               # GET/POST/DELETE /api/guilds/:guildId/feature/slow-mode-channels
3. In feature-toggle/models/bot-feature-state.model.ts, add "slow-mode"
   to BUILTIN_FEATURE_KEYS.
4. In bootstrap-events.ts, call registerSlowModeEvents.
5. In bootstrap-in-process.ts, call registerSlowModeCommands.
6. In guild-management/guild-management-routes.ts, register
   registerSlowModeRoutes in the facade.
7. Add tests under tests/.
8. pnpm build / pnpm test should pass.
```

A new feature touches **one new directory + four wiring points**
(bootstrap × 2, feature-toggle key, guild-management facade). The new
table is created by `sequelize.sync()` automatically — no migration file
is needed for a brand-new table (`sync()` creates missing tables on every
boot, on fresh and existing DBs alike). A migration is only needed when
**altering an existing** table; see [operations.md](operations.md#upgrades).

---

## Adding a new web API endpoint (existing module)

```
1. Add server.<method>(...) in the module's routes file.
2. Gate with web-core's requireCapability(...) or
   requireGuildCapability(...).
3. Validate with web-core/validators.ts helpers (isSnowflake,
   isBoundedString, ...).
4. For admin operations, await recordAudit(...) (from
   admin/admin-audit.service).
5. Call into the module's services / models.
6. pnpm build + pnpm test.
```

---

## Adding a new Discord event handler

```
1. Pick the right module by event semantics.
2. Function signature: export function registerXxxEvents(bot: Client): void.
3. Call register in src/bootstrap-events.ts.
4. Inside: bot.on(Events.XYZ, async (...) => { try { ... } catch (err) { ... } }).
   The outer try/catch is mandatory — one unhandled handler exception
   must not crash the process.
```

---

## Adding a new Sequelize model

```
1. In the right module's models/ (create if missing).
2. import { sequelize } from "../../../db.js";  ← depth depends on module nesting
3. export const X = sequelize.define("X", {...}, {...});
4. The model must be imported on the startup path (directly or
   transitively) so sequelize.sync() registers it.
5. Express the full schema (columns, indexes including partial,
   ENUMs) in the model definition. The model is the source of truth
   for the **fresh-install** schema — `sequelize.sync()` creates the
   table from it. Later changes to an **existing** table (new column,
   altered index/type) need an Umzug migration (`src/migrations/NNN-*.ts`),
   because `sync()` only creates missing tables and never ALTERs.
6. Don't export the raw sequelize; route all access through model
   methods or services.
```

---

## Known tensions and trade-offs

### 1. builtin-features mixes bot side and web side per feature

Each `builtin-features/<name>/` mixes commands (bot), events (bot),
routes (web), and model (shared). **Accepted because** all facets of one
feature live together; vertical slicing pays off more than the layered
alternative.

### 2. command-system and behavior are separate modules

`behavior` stores only the rules; `command-system` does the reconcile
and dispatch. The split exists because the dispatch engine serves both
behaviors (track 2) and `plugin_commands` (track 3); it does not belong
solely to `behavior`.

### 3. `plugin-routes.ts` carries plugin-guild-feature toggle endpoints

By responsibility those toggles belong in `feature-toggle`. They live
in `plugin-routes.ts` instead because they are tightly entangled with
the plugin admin routes. **Trade-off accepted** for `plugin-routes`
completeness.

### 4. `guild-management` ↔ `builtin-features` mutual import

Driven by facade design. `builtin-features` imports only the
`GuildManagementRoutesOptions` type, so there is no runtime edge.

### 5. `tests/` is flat

It does not mirror `src/`. **Trade-off accepted**: keeping tests flat
lets every import start at `../src/...`, which is simple.

---

## Do not break

When refactoring, hold the following invariants:

1. **Do not collect every route in one `web/` directory** — that would
   undo this refactor.
2. **Do not collect every model in one `models/` directory** — same.
3. **Do not create a new business module outside `modules/`**.
4. **Do not let `web-core/` depend on a business module** — the only
   exception is `server.ts`, which exists to register routes.
5. **Do not bypass `bootstrap-events.ts` and `bootstrap-in-process.ts`**
   — Discord events and in-process commands must go through these two
   central registration points.
6. **Do not add new files at `src/` root** unless they are entry-level
   (`db.ts`, `main.ts`, `config.ts`, `logger.ts`, `bootstrap-*`).
7. **Do not drop the `.js` extension from imports** — ESM + NodeNext
   requires it; runtime will break.
8. **Schema changes go in the model** — the model is the single source
   of truth.

---

## Further reading

- [`development.md`](development.md) — development environment, scripts, CI.
- [`permissions.md`](permissions.md) — capability system.
- [`development/plugin-guide.md`](development/plugin-guide.md) — plugin
  protocol (full).
- [`features/`](features/) — builtin features and the behaviors design.
- [`operations.md`](operations.md) — deployment, env vars, health
  checks, schema-evolution caveats.

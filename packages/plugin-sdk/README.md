# @karyl-chan/plugin-sdk

Shared SDK for karyl-chan plugins. The SDK lives in the same monorepo as the
bot (`packages/bot/`); the bot side of the plugin protocol is documented at
[`packages/bot/docs/development/plugin-guide.md`](../bot/docs/development/plugin-guide.md).

> **New here?** Scaffold a plugin in ~10 minutes with
> [`create-karyl-plugin`](../create-karyl-plugin/README.md), then read the
> task guides in [`docs/`](docs/README.md): [getting-started](docs/getting-started.md),
> [plugin-lifecycle](docs/plugin-lifecycle.md), [permissions](docs/permissions.md).
> This README is the API reference.

Running your plugin against your **own self-hosted bot** (external authors,
single docker-compose with both services)? Start with
[`docs/self-host-deployment.md`](docs/self-host-deployment.md) — official bot
image, setup-secret flow, register→enable journey, readiness semantics, and a
troubleshooting table.

The SDK encapsulates the boilerplate every plugin needs:

- A Fastify server with HMAC-verified dispatch on `/commands/:commandName`
  (and `…/autocomplete`), `/components` (buttons + select menus),
  `/modals/:modalId`, `/_kc/lifecycle` (enable / disable), and `/events`
  (Discord-side events).
- A plugin lifecycle client: `register` + `heartbeat` + automatic re-register
  on `401`.
- HMAC signing helpers byte-for-byte compatible with the bot's
  `packages/bot/src/utils/hmac.ts`.
- A manifest builder driven by `definePlugin` — stamps the SDK semver
  onto every manifest as `sdk_version` and auto-derives most of
  `rpcMethodsUsed` from declarative signals.
- `verifyPluginSession()` — offline Ed25519 verification of `plugin-session`
  JWTs, used by plugins that expose a WebUI.
- A typed RPC facade (`ctx.discord.*` / `ctx.voice.*` / `ctx.me.*` /
  `ctx.kv.*` / `ctx.auth.*`) over the bot's `/api/plugin/*` routes,
  with built-in `503` / `429` / network-error retry.

---

## Quick start

```ts
import { definePlugin, definePluginCommand } from '@karyl-chan/plugin-sdk';
import { randomUUID } from 'node:crypto';

export default function buildPlugin() {
  return definePlugin({
    key: 'karyl-example',
    name: 'Karyl Example',
    version: '0.1.0',
    description: 'Pure-logic example commands.',
    pluginCommands: [
      definePluginCommand({
        name: 'uuid',
        description: 'Generate a v4 UUID',
        scope: 'guild',
        integrationTypes: ['guild_install'],
        contexts: ['Guild', 'BotDM', 'PrivateChannel'],
        handler: async (_ctx) => '🔑 `' + randomUUID() + '`',
      }),
    ],
  });
}

// index.ts
const started = await buildPlugin().start();
// Reads PORT, HOST, BOT_URL, PLUGIN_URL, KARYL_PLUGIN_SETUP_SECRET from env.
// Or pass overrides: await buildPlugin().start({ port: 3000, botUrl: 'http://…' });
```

`definePlugin` accepts these top-level fields (all optional except
`key` / `name` / `version`):

| Field | Purpose |
|-------|---------|
| `pluginCommands` | Top-level slash commands. |
| `guildFeatures` | Feature-gated command groups, each with its own enable toggle. |
| `components` | Button + select-menu handlers. |
| `modals` | Modal-submit handlers. |
| `capabilities` | Custom capability tokens (`plugin:<key>:<cap>`). |
| `eventHandlers` | Discord-side event handlers (`Events.GuildMessageCreate`, …). |
| `storage` | `{ guildKv: true }` opts the plugin into per-guild KV. |
| `rpcMethodsUsed` | Extra `/api/plugin/*` scopes the auto-deriver can't see. |
| `onReady(server)` | Mount custom Fastify routes (e.g. a WebUI). |
| `onStart(ctx)` | Background-task hook; ctx lives the whole process. |
| `onStop(ctx)` | Graceful shutdown counterpart. |
| `onEnable / onDisable(ctx, guildId)` | Per-guild lifecycle. |
| `healthCheck(ctx)` | Custom `/health/detail` producer. |

---

## Lifecycle

`start()` performs the following steps:

1. Builds a Fastify instance (`logger: true`).
2. Mounts the SDK's HMAC-verified routes (auto-mounted only when the
   relevant declaration exists):
   - `GET /health` and `GET /health/detail` — liveness + rich
     `HealthReport` for the bot's 60-s poll
   - `POST /commands/:name` (always when at least one command is declared)
   - `POST /commands/:name/autocomplete` (when any command has `autocomplete`)
   - `POST /components` (when `components` is non-empty)
   - `POST /modals/:modalId` (when `modals` is non-empty)
   - `POST /_kc/lifecycle` (when `onEnable` / `onDisable` is declared)
   - `POST /events` (when `eventHandlers` is non-empty)
3. Runs the `onReady(server)` hook, then calls `listen()` on `PORT` / `HOST`.
4. If `KARYL_PLUGIN_SETUP_SECRET` is set: builds the manifest (auto-stamped
   with `sdk_version` and auto-derived `rpcMethodsUsed`) and starts the
   lifecycle client (register + heartbeat, exponential-backoff retry,
   automatic re-register on `401`).
5. On the first successful register: fires the `onStart(ctx)` hook with a
   fully populated `PluginContext`.
6. Registers `SIGTERM` / `SIGINT` for graceful shutdown.
7. Returns a `StartedPlugin` with these handles (the typed RPC accessors
   are only useful after the first successful register):
   - `server` — the Fastify instance.
   - `address()` — the listening address.
   - `stop()` — graceful shutdown.
   - `botRpc(path, body)` — escape-hatch RPC for methods not in the typed
     facade.
   - `discord` / `voice` / `me` / `kv` / `auth` — typed RPC facade.
   - `getSessionVerifyPublicKey()` — Ed25519 public key for JWT verification.
   - `getPublicBaseUrl()` — bot-proxied public URL of this plugin's WebUI.
   - `getDispatchHmacKey()` — per-plugin HMAC key (rarely needed; the
     SDK verifies inbound dispatches itself).

### Lifecycle hooks

| Hook | When | Receives | Notes |
|------|------|----------|-------|
| `onReady(server)` | After SDK mounts its routes, before `listen()` | Fastify instance | Add custom routes here. |
| `onStart(ctx)` | After first successful register | `PluginContext` | Once per process. Capture `ctx` for background timers. |
| `onStop(ctx)` | On SIGTERM / SIGINT or `started.stop()` | `PluginContext` | Tear down timers, drain queues, flush state. |
| `onEnable(ctx, guildId)` | Operator enables a feature in a guild | `PluginContext` + guildId | Triggered via `/_kc/lifecycle`. |
| `onDisable(ctx, guildId)` | Operator disables a feature | `PluginContext` + guildId | Same dispatch path as `onEnable`. |
| `healthCheck(ctx)` | Bot polls `/health/detail` (~60 s) | `PluginContext` | Should complete inside ~2 s; bot times out at 3 s. |

---

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Listen port. |
| `HOST` | `0.0.0.0` | Listen host. |
| `BOT_URL` | `http://karyl-chan:3000` | Bot base URL. |
| `PLUGIN_URL` | `http://{key}:3000` | This plugin's URL (sent to the bot in the manifest; the bot dispatches here). **Set this explicitly in production** — the default assumes the docker hostname equals `config.key`. |
| `KARYL_PLUGIN_SETUP_SECRET` | — | Per-plugin setup secret. An admin pre-provisions it via `POST /api/plugins/setup-secret`. When unset, the plugin serves dispatch but never registers. |

---

## `PluginContext` reference

The same instance is passed to `onStart` / `onStop` / `onEnable` /
`onDisable` and lives for the whole process — capture it from `onStart`
and reuse it from any background task or custom route.

```ts
interface PluginContext {
  readonly pluginKey: string;
  readonly manifest: PluginManifest;
  readonly log: PluginLogger;        // local pino → stdout
  readonly botEventLog: PluginBotEventLog;  // structured rows in admin event feed
  readonly metrics: PluginMetrics;   // counters / gauges / histograms
  readonly botRpc(path, body): Promise<unknown>;  // escape hatch
  readonly discord: Discord;         // typed messages / members / interactions
  readonly voice: Voice;             // typed voice
  readonly me: Me;                   // enabledGuilds / kvUsage
  readonly kv: Kv;                   // per-guild typed KV
  readonly auth: Auth;               // mintSession for WebUI links
}
```

`CommandContext` / `ComponentContext` / `ModalContext` carry the same
typed-facade surface plus per-interaction fields (`userId`, `guildId`,
`channelId`, `interactionToken`, locale fields). See `src/types.ts` for
exact shapes.

---

## `CommandContext`

Every command handler receives a `CommandContext`:

```ts
interface CommandContext {
  pluginKey: string;
  commandName: string;
  subCommandName: string | null;
  options: Record<string, unknown>;  // parsed { name: value }
  guildId: string | null;
  channelId: string | null;
  userId: string;
  userDisplayName: string;           // global → username → id fallback
  capabilities: string[];            // bot-resolved subset for this dispatch
  hasCapability(capKey: string): boolean;
  interactionId: string;
  interactionToken: string;
  log: Logger;
  publicBaseUrl?: string;            // see "publicBaseUrl" section
  botRpc(path: string, body?: unknown): Promise<unknown>;  // escape hatch
  // Typed RPC facade
  discord: Discord;
  voice: Voice;
  me: Me;
  kv: Kv;
  auth: Auth;
  sendModal(modal: ModalData): Promise<boolean>;
}
```

A handler returns a `CommandReply`: either a plain string (treated as
`{ content }`) or an object `{ content?, embeds?, components?, ephemeral?, flags?, attachments? }`.

### Ephemeral semantics

Discord locks ephemerality at defer time, so the bot decides
ephemeral-vs-public BEFORE the handler runs by reading
`definePluginCommand({ defaultEphemeral })` from the manifest (defaults
to `true`). The handler's return value's `ephemeral` either matches
that — clean `@original` edit, single message — or mismatches, in which
case the bot posts a follow-up of the desired ephemerality and deletes
`@original` so the user still sees a single message. Plain strings and
objects with `ephemeral` omitted inherit the command's
`defaultEphemeral`.

### Command options

```ts
import {
  definePluginCommand,
  ApplicationCommandOptionType,
} from '@karyl-chan/plugin-sdk';

definePluginCommand({
  name: 'remind-add',
  description: 'Schedule a reminder.',
  scope: 'guild',
  integrationTypes: ['guild_install'],
  contexts: ['Guild'],
  options: [
    {
      type: ApplicationCommandOptionType.String,
      name: 'when',
      description: 'Duration like 10m, 2h, 1d.',
      required: true,
    },
    {
      type: ApplicationCommandOptionType.String,
      name: 'what',
      description: 'What should I remind you about?',
      required: true,
    },
  ],
  handler: async (ctx) => `OK: ${ctx.options.what} in ${ctx.options.when}`,
});
```

The SDK re-exports `ApplicationCommandOptionType` / `ComponentType` /
`ButtonStyle` / `TextInputStyle` / `ChannelType` /
`InteractionContextType` from `discord-api-types/v10` so plugin code
can avoid magic numbers.

---

## Typed RPC facade

The five typed namespaces hide the wire path, snake_case body
translation, and retry/error narrowing:

```ts
// discord — messages, members, interactions
await ctx.discord.messages.send({ channelId, content: 'hi' });
await ctx.discord.interactions.respond({ interactionToken, content: 'ack' });

// voice
await ctx.voice.play({ guildId, url });

// me — plugin introspection
const guildIds = await ctx.me.enabledGuilds();
const { usedBytes, quotaBytes } = await ctx.me.kvUsage({ guildId });

// kv — per-guild typed key-value store with built-in JSON codec
interface Reminder { id: string; dueAtMs: number; text: string }
const kv = ctx.kv.guild<Reminder>(guildId);
await kv.set(`r:${row.id}`, row);
const { entries } = await kv.listValues({ prefix: 'r:' });

// auth — WebUI session token
const session = await ctx.auth.mintSession({
  userId: ctx.userId,
  kind: 'session',      // or 'manage' (requires plugin:<key>:manage)
  guildId: ctx.guildId,
});
```

Methods not yet in the typed facade (`channels.*`, `roles.*`, `users.*`,
`messages.send_dm`, `messages.fetch_history`, `messages.get`) remain
available via `ctx.botRpc(path, body)`. New methods join the typed
facade additively in subsequent minor releases.

### `BotRpcError` + retry behaviour

Every typed method (and `ctx.botRpc`) throws `BotRpcError` on failure
with a discriminated `reason`:

```ts
import { BotRpcError } from '@karyl-chan/plugin-sdk';

try {
  await ctx.kv.guild(guildId).set(key, value);
} catch (err) {
  if (err instanceof BotRpcError) {
    switch (err.reason) {
      case 'quota_exceeded': /* per-guild KV quota busted */
      case 'forbidden':      /* scope missing or feature not enabled */
      case 'rate_limited':   /* 429 after SDK exhausted retries */
      case 'network':        /* DNS / connection / abort */
      case 'no_token':       /* plugin not yet registered */
      case 'http_status':    /* every other 4xx/5xx */
    }
  }
}
```

The SDK retries on `503` / `429` / network errors up to 3 times with
exponential backoff (200 ms base, 1.5 s cap, ±30% jitter; respects
`Retry-After`). Other failures (`500`, `502`, `504`, any `4xx`) are
surfaced immediately because the bot may already have processed the
request. **Plugin code MUST NOT add its own retry layer** — that
compounds backoff and swamps the bot during real outages.

---

## Storage (`ctx.kv.*`)

Per-guild key-value store, JSON-serialised, with quota enforcement.

```ts
import type { GuildKv } from '@karyl-chan/plugin-sdk';

interface Reminder { id: string; dueAtMs: number; text: string }

const kv: GuildKv<Reminder> = ctx.kv.guild<Reminder>(guildId);

await kv.set(`r:${row.id}`, row);           // JSON.stringify under the hood
const row = await kv.get(`r:${id}`);        // returns Reminder | null
const { entries, total } = await kv.listValues({ prefix: 'r:', limit: 50 });
await kv.delete(`r:${id}`);                 // returns true when row existed
const { value: next } = await kv.increment('counter'); // atomic numeric increment
const { usedBytes, quotaBytes } = await kv.usage();
```

Hard caps (importable as constants):

| Constant | Value | Meaning |
|----------|-------|---------|
| `KV_KEY_MAX` | `200` | Max key length in characters. |
| `KV_VALUE_MAX_BYTES` | `65_536` | Max serialised value size per row. |

Per-guild quota is configurable in the manifest:

```ts
definePlugin({
  // ...
  storage: { guildKv: true, guildKvQuotaKb: 512 },
});
```

Default quota is bot-wide (`DEFAULT_KV_QUOTA_BYTES`). Setting
`guildKv: true` also auto-adds every `storage.kv_*` scope to
`rpcMethodsUsed`, so plugin authors don't have to enumerate them.

**KV is per-guild only.** There is no global namespace — cross-guild
indexes have to be built outside KV (e.g. a per-process Set seeded
from `ctx.me.enabledGuilds()`).

---

## Auto-derived `rpcMethodsUsed`

The manifest builder unions the explicit `rpcMethodsUsed` array with
scopes implied by other declarations, so plugin authors don't run
into 403s from `requireScope` on the bot side after switching from
`botRpc(path, …)` to a typed facade.

Auto-injected when present:

| Declarative signal | Scopes added |
|--------------------|--------------|
| ≥1 command / component / modal | `interactions.respond`, `interactions.followup` |
| ≥1 `modal:true` or `modals[]` | `interactions.send_modal` |
| `storage.guildKv: true` | `storage.kv_{get,set,list,list_values,delete,increment}`, `me.kv_usage` |
| `onStart` / `onStop` present | `me.enabled_guilds` |
| Always | `me.log`, `me.metrics` |

The explicit `rpcMethodsUsed` array stays the documented escape hatch
for any scope the auto-rules don't cover (e.g. `voice.*`, `channels.*`,
`roles.*`, `members.add_role`, `messages.send_dm`, `auth.session`).

---

## Background tasks

`onStart(ctx)` is the canonical place to wire background work. The
`PluginContext` it receives is alive for the whole process, so
capturing it lets `setInterval` / queue consumers / cron jobs reach
the typed facade and metrics surface without any extra plumbing.

```ts
import { definePlugin, type PluginContext } from '@karyl-chan/plugin-sdk';

let stopTimer: (() => void) | null = null;

export default definePlugin({
  key: 'karyl-digest',
  name: 'Daily Digest',
  version: '0.1.0',

  async onStart(ctx: PluginContext) {
    let stopped = false;
    const tick = async () => {
      if (stopped) return;
      try {
        const guildIds = await ctx.me.enabledGuilds();
        for (const guildId of guildIds) {
          await runOnce(ctx, guildId);
        }
      } catch (err) {
        ctx.log.warn('digest tick failed', { err: String(err) });
      } finally {
        if (!stopped) setTimeout(tick, 60_000);
      }
    };
    setTimeout(tick, 60_000);
    stopTimer = () => { stopped = true; };
  },

  async onStop(_ctx) {
    if (stopTimer) stopTimer();
    stopTimer = null;
  },
});
```

`ctx.me.enabledGuilds()` returns every guild this plugin is currently
active in — when the plugin declares ≥1 `guildFeatures` it returns
feature-enabled guilds; when there are no features (e.g. an
unconditional background worker) it returns every guild the bot is
in. POST-only since 0.9; older SDK versions had a GET that
`botRpc` (POST-only) could never reach.

---

## Event handlers (Discord-side events)

Plugins subscribe to events by declaring handlers; the SDK auto-mounts
`/events`, verifies the bot's HMAC, parses the JSON envelope, and
dispatches by event type. Use the `Events` constant so a typo can't
silently subscribe to nothing:

```ts
import { definePlugin, Events, type EventHandler } from '@karyl-chan/plugin-sdk';

definePlugin({
  // …
  eventHandlers: {
    [Events.GuildMessageCreate]: async (ctx, data) => {
      const msg = data as { channel_id: string; content?: string; author: { id: string } };
      if (msg.content === '!ping') {
        await ctx.discord.messages.send({ channelId: msg.channel_id, content: 'pong' });
      }
    },
  },
});
```

Canonical event names today (additive over time):

| Constant | Wire name | When |
|----------|-----------|------|
| `Events.GuildMessageCreate` | `guild.message_create` | Non-bot message in a guild text channel. |
| `Events.DmMessageCreate` | `dm.message_create` | Non-bot DM to the bot. |
| `Events.GuildMessageReactionAdd` | `guild.message_reaction_add` | Reaction added to a guild message. |
| `Events.GuildMessageReactionRemove` | `guild.message_reaction_remove` | Reaction removed from a guild message. |

The handler keys are merged into `events_subscribed_global` in the
manifest automatically, and `endpoints.events = "/events"` is set so the
bot dispatches here. Plugins do **not** mount their own `/events` route
or implement HMAC verification — the SDK owns both. Future transport
swaps (HTTP → Redis Streams, batching) happen inside the SDK without
changing handlers.

The manifest builder warns at build time if any subscribed event name
isn't in `Events.*` — that catches dead subscriptions like the raw
Discord-API `MESSAGE_CREATE` (which the bot never emits; it always
namespaces into `guild.*` / `dm.*`).

### Feature-scoped event subscriptions

`defineGuildFeature.eventsSubscribed` still works for per-feature
gating (the bot only dispatches when the feature is enabled in that
guild). The same canonical names apply. Use it when an event should
only fire while a specific feature is enabled; use the top-level
`eventHandlers` for plugin-wide subscriptions.

---

## `publicBaseUrl` (bot-proxied WebUI base)

When the bot has `WEB_BASE_URL` configured, it exposes every registered
plugin's HTTP surface at `<WEB_BASE_URL>/plugin/<pluginKey>/` and includes a
`publicBaseUrl` field (for example, `http://localhost:902/plugin/karyl-radio`)
in its register and heartbeat responses. The SDK stores the value and surfaces
it in two places:

- `StartedPlugin.getPublicBaseUrl(): string | undefined` — wire it into the
  WebUI layer after `start()` resolves (the same shape as
  `getSessionVerifyPublicKey()`).
- `CommandContext.publicBaseUrl?: string` — available inside every command
  handler; use it to build browser-facing links.

The value is `undefined` until the first successful register *and* only when
the bot has `WEB_BASE_URL` set. Handle the fallback with a plugin-side env
variable or a hardcoded default. `publicBaseUrl` supersedes any manually-set
public-URL env variable when the plugin is accessed through the bot proxy.

---

## WebUI authentication

When a plugin hands a user a browser link, it mints a `plugin-session` JWT:

```ts
const session = await ctx.auth.mintSession({
  userId: ctx.userId,
  kind: 'session',       // 'manage' for admin surfaces
  guildId: ctx.guildId ?? undefined,
});
if (!session.allowed) {
  return { content: 'No permission.', ephemeral: true };
}
// session.token + session.expiresAt
```

The two `kind` values:

| Kind | Capability gate | Default TTL |
|------|-----------------|-------------|
| `'session'` | None (the slash command is permission-gated). | 6 h |
| `'manage'` | Requires `admin` OR `plugin:<key>:manage` on the user. | 15 min |

The plugin puts the token in the link. On the WebUI side, verify it offline:

```ts
import { verifyPluginSession, hasPluginCapability } from '@karyl-chan/plugin-sdk';

const claims = verifyPluginSession(token, getSessionVerifyPublicKey());
// claims: { userId, guildId, capabilities } | null
if (!claims) return reply.code(401).send();
if (!hasPluginCapability(claims.capabilities, pluginKey, 'webui.access')) {
  return reply.code(403).send();
}
```

`getSessionVerifyPublicKey()` (from `StartedPlugin` or
`client.getSessionVerifyPublicKey()`) returns the bot's Ed25519 public key.
The bot signs these tokens with the corresponding private key, which never
leaves the bot, so a compromised plugin can verify tokens but cannot forge
them. The key is re-sent on every heartbeat, so a key rotation propagates in
roughly 30 seconds.

---

## Protocol alignment

- **HMAC.** Signed payload is `<METHOD>:<path>:<ts>:<body>`; binding the
  method and URL path prevents a captured signature from being replayed
  against a different endpoint. Headers: `x-karyl-signature` (hex
  SHA-256), `x-karyl-timestamp` (unix seconds). Replay window ±300 s.
  Plugins that mount their own bot-dispatched routes (custom webhook
  receivers) can validate inbound POSTs with the one-call helper
  `verifyDispatchHmac({ secret, method, path, body, headers })`.
- **Manifest.** Auto-stamped with `sdk_version` (read from this package's
  semver at build time). Includes commands (with the three-axis spec:
  scope / integration types / contexts), guild features, components,
  modals, capabilities, and `events_subscribed_global` (derived from
  `eventHandlers` keys + per-feature `eventsSubscribed`).
  `rpcMethodsUsed` is auto-derived from declarative signals (see above).
- **Dispatch.** `POST /commands/{name}` (and `/commands/{name}/autocomplete`),
  `/components`, `/modals/{modal_id}`, `/_kc/lifecycle`, `/events`. The
  plugin completes a deferred reply by calling
  `ctx.discord.interactions.respond(...)` (or
  `POST ${BOT_URL}/api/plugin/interactions.respond` over `botRpc`).

---

## Backwards-compatibility commitment

Starting at 1.0 the SDK commits to these stability rules; pre-1.0 the
project (`karyl-chan`) is allowed breaking changes in lockstep with the
bot, but plugins **inside this monorepo** are kept in sync at every
release.

Stable surface (no breaking changes within a major):

1. `PluginConfig` field semantics — additive only.
2. `definePlugin*` / `componentCustomId` / `modalCustomId` validation rules.
3. `PluginContext` / `CommandContext` / `ComponentContext` /
   `ModalContext` field semantics — additive only.
4. `ctx.discord.*` / `ctx.voice.*` / `ctx.me.*` / `ctx.kv.*` /
   `ctx.auth.*` typed-method signatures — additive only.
5. `ctx.botRpc(path, body)` path semantics — even after a method joins
   the typed facade, the string-path form keeps working.
6. Manifest schema — additive only.
7. HMAC wire format (header names, canonical string, ±300 s window).
8. `BotRpcError.reason` values may grow but never shrink.
9. SDK-mounted route paths (`/health`, `/health/detail`,
   `/commands/:name`, `…/autocomplete`, `/components`,
   `/modals/:modalId`, `/_kc/lifecycle`, `/events`).
10. `Events.*` constants — wire names never change once published.

Allowed non-breaking evolution:

- New methods on `ctx.discord.*` / `ctx.voice.*` / `ctx.me.*` /
  `ctx.kv.*` / `ctx.auth.*` (or a new namespace).
- New optional fields on `PluginConfig` / contexts / manifest.
- Internal transport swaps (e.g. event dispatch HTTP → Redis Streams) —
  the plugin author's surface is unchanged.
- Additional `BotRpcError.reason` values.
- Additional inbound retry on transient bot states.
- Additional canonical events on `Events.*`.

---

## Docker

Each plugin ships its own Dockerfile (typically multi-stage: SDK + plugin
together). The bot's `karyl-chan-net` external network must exist first —
bring the bot up before the plugins.

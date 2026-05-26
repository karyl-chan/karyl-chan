# @karyl-chan/plugin-sdk

Shared SDK for karyl-chan plugins. The SDK lives in the same monorepo as the
bot (`packages/bot/`); the bot side of the plugin protocol is documented at
[`packages/bot/docs/development/plugin-guide.md`](../bot/docs/development/plugin-guide.md).

The SDK encapsulates the boilerplate every plugin needs:

- A Fastify server with HMAC-verified dispatch on `/commands/:commandName`
  (and `…/autocomplete`), `/components` (buttons + select menus), `/modals/:modalId`,
  `/_kc/lifecycle` (enable / disable), and `/events` (Discord-side events).
- A plugin lifecycle client: `register` + `heartbeat` + automatic re-register
  on `401`.
- HMAC signing helpers byte-for-byte compatible with the bot's
  `packages/bot/src/utils/hmac.ts`.
- A manifest builder driven by the `definePlugin` configuration — stamps the
  SDK semver onto every manifest as `sdk_version`.
- `verifyPluginSession()` — offline Ed25519 verification of `plugin-session`
  JWTs, used by plugins that expose a WebUI.
- A typed RPC facade (`ctx.discord.*` / `ctx.voice.*`) over the bot's
  `/api/plugin/*` routes, with built-in `503` / `429` / network-error retry.

## Quick start

```typescript
import { definePlugin, definePluginCommand } from '@karyl-chan/plugin-sdk';
import { randomUUID } from 'node:crypto';

export default function buildPlugin() {
  return definePlugin({
    key: 'karyl-example',
    name: 'Karyl Example',
    version: '0.1.0',
    description: 'Pure-logic example commands.',
    rpcMethodsUsed: ['interactions.respond'],
    storage: { guildKv: false },
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

`definePlugin` also accepts `guildFeatures` (`defineGuildFeature`),
`components` (`definePluginComponent` — button + select-menu handlers),
`modals` (`definePluginModal`), `capabilities` (`definePluginCapability`),
and `eventHandlers` (Discord-side events, see below). An `onReady(server)`
hook lets the plugin register additional Fastify routes (for example, a
WebUI) before `listen()`.

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
   with `sdk_version`) and starts the lifecycle client (register +
   heartbeat, exponential-backoff retry, automatic re-register on `401`).
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
   - `discord` / `voice` — typed RPC facade, see [Typed RPC facade](#typed-rpc-facade).
   - `getSessionVerifyPublicKey()` — Ed25519 public key for JWT verification.
   - `getPublicBaseUrl()` — bot-proxied public URL of this plugin's WebUI.
   - `getDispatchHmacKey()` — per-plugin HMAC key (rarely needed; the
     SDK verifies inbound dispatches itself).

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Listen port. |
| `HOST` | `0.0.0.0` | Listen host. |
| `BOT_URL` | `http://karyl-chan:3000` | Bot base URL. |
| `PLUGIN_URL` | `http://{key}:3000` | This plugin's URL (sent to the bot in the manifest; the bot dispatches here). **Set this explicitly in production** — the default assumes the docker hostname equals `config.key`. |
| `KARYL_PLUGIN_SETUP_SECRET` | — | Per-plugin setup secret. An admin pre-provisions it via `POST /api/plugins/setup-secret`. When unset, the plugin serves dispatch but never registers. |

## `CommandContext`

Every command handler receives a `CommandContext`:

```typescript
interface CommandContext {
  pluginKey: string;                 // = manifest.plugin.id
  commandName: string;
  subCommandName: string | null;
  options: Record<string, unknown>;  // parsed { name: value }
  guildId: string | null;
  channelId: string | null;
  userId: string;
  userDisplayName: string;           // global → username → id fallback
  capabilities: string[];            // bot-resolved subset for this dispatch
  hasCapability(capKey: string): boolean;  // admin OR plugin:<key>:<capKey>
  interactionId: string;             // for sendModal()
  interactionToken: string;
  log: Logger;
  publicBaseUrl?: string;            // see "publicBaseUrl" section
  // Escape hatch — string-path RPC. Throws BotRpcError on failure.
  botRpc(path: string, body?: unknown): Promise<unknown>;
  // Typed RPC facade — see below.
  discord: Discord;
  voice: Voice;
  // Open a Discord modal (only valid for commands declared `modal: true`).
  sendModal(modal: ModalData): Promise<boolean>;
}
```

A handler returns a `CommandReply`: either a plain string (treated as
`{ content }`) or an object `{ content?, embeds?, components?, ephemeral?, flags?, attachments? }`.

**Ephemeral semantics.** Discord locks ephemerality at defer time, so
the bot decides ephemeral-vs-public BEFORE the handler runs by reading
`definePluginCommand({ defaultEphemeral })` from the manifest (defaults
to `true`). The handler's return value's `ephemeral` either matches
that — clean `@original` edit, single message — or mismatches, in which
case the bot posts a follow-up of the desired ephemerality and deletes
`@original` so the user still sees a single message. Plain strings and
objects with `ephemeral` omitted inherit the command's
`defaultEphemeral`, so the most common pattern (`return "pong"` on a
default-ephemeral command) stays on the happy path with no extra wiring.

`ComponentContext` and `ModalContext` carry the same `discord` / `voice`
/ `botRpc` surface; see `src/types.ts` for the per-context fields.

## Typed RPC facade

`ctx.discord` and `ctx.voice` (also `started.discord` / `started.voice`
for plugin-token-bound calls outside an interaction handler) hide the
wire path and snake_case body translation:

```typescript
// Old: stringly-typed escape hatch
await ctx.botRpc('/api/plugin/messages.send', {
  channel_id: ctx.channelId,
  content: 'hi',
  components: rows,
});

// New: typed facade (preferred)
await ctx.discord.messages.send({
  channelId: ctx.channelId!,
  content: 'hi',
  components: rows,
});
```

Available methods today:

- `discord.messages.send / edit / delete / addReaction`
- `discord.members.get`
- `discord.interactions.respond / followup / sendModal`
- `voice.join / leave / play / pause / stop / status`

Methods not yet in the typed facade (`channels.*`, `roles.*`, `users.*`,
`storage.kv_*`, `auth.session`, `me.*`) remain available via
`ctx.botRpc(path, body)`. New methods join the typed facade additively
in subsequent minor releases.

### BotRpcError + retry behaviour

`ctx.botRpc` and every typed method throw `BotRpcError` on failure:

```typescript
import { BotRpcError } from '@karyl-chan/plugin-sdk';

try {
  await ctx.discord.messages.send({ channelId, content: 'hi' });
} catch (err) {
  if (err instanceof BotRpcError && err.reason === 'http_status' && err.status === 403) {
    // Plugin not enabled in this guild
  }
  // err.reason ∈ { 'no_token', 'network', 'http_status' }
}
```

The SDK retries on `503` / `429` / network errors up to 3 times with
exponential backoff (200 ms base, 1.5 s cap, ±30% jitter; respects
`Retry-After`). Other failures (`500`, `502`, `504`, any `4xx`) are
surfaced immediately because the bot may already have processed the
request. **Plugin code MUST NOT add its own retry layer** — that
compounds backoff and swamps the bot during real outages.

## Event handlers (Discord-side events)

Plugins subscribe to events by declaring handlers; the SDK auto-mounts
`/events`, verifies the bot's HMAC, parses the JSON envelope, and
dispatches by event type:

```typescript
import { definePlugin, type EventHandler } from '@karyl-chan/plugin-sdk';

definePlugin({
  // …
  eventHandlers: {
    'guild.message_create': async (ctx, data) => {
      const msg = data as { channel_id: string; content?: string; author: { id: string } };
      if (msg.content === '!ping') {
        await ctx.discord.messages.send({ channelId: msg.channel_id, content: 'pong' });
      }
    },
  },
});
```

The handler keys are merged into `events_subscribed_global` in the
manifest automatically, and `endpoints.events = "/events"` is set so the
bot dispatches here. Plugins do **not** mount their own `/events` route
or implement HMAC verification — that was the pre-0.4 pattern. Future
transport swaps (HTTP → Redis Streams, batching) happen inside the SDK
without changing handlers.

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

## WebUI authentication

When a plugin hands a user a browser link, it mints a `plugin-session` JWT
via:

```typescript
const session = await ctx.botRpc('/api/plugin/auth.session', {
  user_id: ctx.userId,
  kind: 'webui',
  guild_id: ctx.guildId,
});
```

The RPC requires the `auth.session` scope. The plugin puts the token in the
link. On the WebUI side, verify it offline:

```typescript
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

## Protocol alignment

- **HMAC.** Signed payload is `<METHOD>:<path>:<ts>:<body>`; binding the
  method and URL path prevents a captured signature from being replayed
  against a different endpoint. Headers: `x-karyl-signature` (hex
  SHA-256), `x-karyl-timestamp` (unix seconds). Replay window ±300 s.
- **Manifest.** Auto-stamped with `sdk_version` (read from this package's
  semver at build time). Includes commands (with the three-axis spec:
  scope / integration types / contexts), guild features, components,
  modals, capabilities, and `events_subscribed_global` (derived from
  `eventHandlers` keys + per-feature `eventsSubscribed`). No
  `schema_version` field — that was a pre-release no-op and was dropped.
- **Dispatch.** `POST /commands/{name}` (and `/commands/{name}/autocomplete`),
  `/components`, `/modals/{modal_id}`, `/_kc/lifecycle`, `/events`. The
  plugin completes a deferred reply by calling
  `ctx.discord.interactions.respond(...)` (or
  `POST ${BOT_URL}/api/plugin/interactions.respond` over `botRpc`).

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
4. `ctx.discord.*` / `ctx.voice.*` typed-method signatures — additive only.
5. `ctx.botRpc(path, body)` path semantics — even after a method joins
   the typed facade, the string-path form keeps working.
6. Manifest schema — additive only.
7. HMAC wire format (header names, canonical string, ±300 s window).
8. `BotRpcError.reason` values (`no_token` / `network` / `http_status`)
   may grow but never shrink.
9. SDK-mounted route paths (`/health`, `/health/detail`,
   `/commands/:name`, `…/autocomplete`, `/components`,
   `/modals/:modalId`, `/_kc/lifecycle`, `/events`).

Allowed non-breaking evolution:

- New methods on `ctx.discord.*` / `ctx.voice.*` (or a new namespace).
- New optional fields on `PluginConfig` / contexts / manifest.
- Internal transport swaps (e.g. event dispatch HTTP → Redis Streams) —
  the plugin author's surface is unchanged.
- Additional `BotRpcError.reason` values.
- Additional inbound retry on transient bot states.

## Docker

Each plugin ships its own Dockerfile (typically multi-stage: SDK + plugin
together). The bot's `karyl-chan-net` external network must exist first —
bring the bot up before the plugins.

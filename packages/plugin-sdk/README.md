# @karyl-chan/plugin-sdk

Shared SDK for karyl-chan plugins. The SDK lives in the same monorepo as the
bot (`packages/bot/`); the bot side of the plugin protocol is documented at
[`packages/bot/docs/development/plugin-guide.md`](../bot/docs/development/plugin-guide.md).

The SDK encapsulates the boilerplate every plugin needs:

- A Fastify server with HMAC-verified dispatch on `/commands/:commandName`
  (and `…/autocomplete`) plus `/components` (button) dispatch.
- A plugin lifecycle client: `register` + `heartbeat` + automatic re-register
  on `401`.
- HMAC signing helpers byte-for-byte compatible with the bot's
  `packages/bot/src/utils/hmac.ts`.
- A manifest builder driven by the `definePlugin` configuration.
- `verifyPluginSession()` — offline Ed25519 verification of `plugin-session`
  JWTs, used by plugins that expose a WebUI.

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
`components` (`definePluginComponent` — button handlers dispatched on
`/components`), and `capabilities` (`definePluginCapability`). An
`onReady(server)` hook lets the plugin register additional Fastify routes
(for example, a WebUI) before `listen()`.

## Lifecycle

`start()` performs the following steps:

1. Builds a Fastify instance (`logger: true`).
2. Mounts `GET /health`, the HMAC-verified `POST /commands/:name` and
   `…/autocomplete` dispatch routes, and `POST /components` if any components
   are declared.
3. Runs the `onReady(server)` hook, then calls `listen()` on `PORT` / `HOST`.
4. If `KARYL_PLUGIN_SETUP_SECRET` is set: builds the v2 manifest and starts
   the lifecycle client (register + heartbeat, exponential-backoff retry,
   automatic re-register on `401`).
5. Registers `SIGTERM` / `SIGINT` for graceful shutdown.
6. Returns a `StartedPlugin` with the following methods (the last three are
   only meaningful after the first successful register):
   - `server` — the Fastify instance.
   - `address()` — the listening address.
   - `stop()` — graceful shutdown.
   - `botRpc(path, body)` — call a bot RPC method.
   - `getSessionVerifyPublicKey()` — Ed25519 public key for JWT verification.
   - `getPublicBaseUrl()` — bot-proxied public URL of this plugin's WebUI.

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
  userId: string;
  log: Logger;
  publicBaseUrl?: string;            // see "publicBaseUrl" section
  botRpc(path: string, body?: unknown): Promise<unknown | null>;
}
```

A handler returns a `CommandReply`: either a plain string (treated as
`{ content }`) or an object `{ content?, embeds?, components?, ephemeral? }`.

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
- **Manifest.** `schema_version: '1'`. Includes commands (with the
  three-axis spec: scope / integration types / contexts), guild features,
  components, and capabilities.
- **Dispatch.** `POST /commands/{name}` (and `/commands/{name}/autocomplete`).
  The plugin completes a deferred reply by calling
  `POST ${BOT_URL}/api/plugin/interactions.respond`.

## Docker

Each plugin ships its own Dockerfile (typically multi-stage: SDK + plugin
together). The bot's `karyl-chan-net` external network must exist first —
bring the bot up before the plugins.

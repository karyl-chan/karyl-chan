# Plugin protocol (bot side)

> This document describes the **bot side** of the plugin protocol:
> authentication, lifecycle, dispatch, RPC. To write an actual plugin, use
> `@karyl-chan/plugin-sdk` (the SDK lives in the same monorepo at
> `packages/plugin-sdk/`); see [`packages/plugin-sdk/README.md`](../../../plugin-sdk/README.md).

A karyl-chan plugin is a **sibling service on the same Docker network**,
not an in-process module. A plugin registers its manifest with the bot at
startup; the bot dispatches Discord interactions and events to it; the
plugin uses bidirectional RPC to operate the bot. Every cross-service call
is HMAC-signed or bearer-authenticated, and no secret is shared across
plugins — compromising one plugin cannot leak into another or into the bot
itself.

## Authentication and lifecycle

```
Admin pre-provisions a per-plugin setup secret:
   POST /api/plugins/setup-secret { pluginKey }
   ← { setupSecret }     (returned once; stored as KARYL_PLUGIN_SETUP_SECRET in the plugin)

Plugin start:
   POST /api/plugins/register
     header  X-Plugin-Setup-Secret: <setupSecret>
     body    { manifest }                       (manifest.sdk_version
                                                  auto-stamped by the SDK)
   ← { plugin, token, dispatchHmacKey, sessionVerifyPublicKey,
       publicBaseUrl?, heartbeat: { path, interval_seconds } }

Every ~30 s the plugin pings:
   POST /api/plugins/heartbeat   header  Authorization: Bearer <token>
   ← { ok: true, sessionVerifyPublicKey, publicBaseUrl? }   (latest rotated values)

401 (the bot has restarted and cleared its token cache) → the plugin re-registers.
```

| Field | Purpose |
|-------|---------|
| `X-Plugin-Setup-Secret` | One per plugin; pre-provisioned by an admin with `POST /api/plugins/setup-secret`. The bot stores only the SHA-256 hash; the cleartext is returned exactly once. There is no global fallback — a plugin without a `setupSecretHash` row in the DB cannot register. |
| `token` (bearer) | Issued at register, rotated on every re-register. The bot stores only the hash. Used for every `/api/plugin/*` RPC. Heartbeat extends its expiry. |
| `dispatchHmacKey` | `randomBytes(32)` generated on first register; stored cleartext in the bot's DB; returned to the plugin once. **Every dispatch from the bot to the plugin is HMAC-signed with this key**; the plugin verifies on receipt. |
| `sessionVerifyPublicKey` | Public key (SPKI PEM) of the bot's JWT signing authority (Ed25519, see `src/modules/web-core/jwt.service.ts`). Plugins with a WebUI use it to verify `plugin-session` tokens offline. Plugins without a WebUI can ignore it. Re-sent in every register and heartbeat response (a rotation propagates within ~30 s). |

## Bot → Plugin dispatch (slash command / autocomplete / event)

For each dispatch, the bot POSTs a JSON payload to the manifest-declared
endpoint with these headers:

| Header | Value |
|--------|-------|
| `X-Karyl-Timestamp` | Unix seconds. |
| `X-Karyl-Signature` | `<hex>` = `HMAC_SHA256(dispatchHmacKey, "<METHOD>:<path>:<ts>:<body>")`. |

Method + path are bound into the signed payload, which prevents a
captured signature from being replayed against a different endpoint or
verb. Timestamps that differ from local time by more than ±300 seconds
are rejected. The SDK's `createPluginServer` does this for you.

### Slash command

The bot calls `deferReply` (3-second budget) and POSTs to the plugin's
`/commands/:commandName`. It **does not wait** for the response. The
plugin completes the deferred reply by calling
`/api/plugin/interactions.respond` over RPC (Discord allows 15 minutes
for completion).

### Autocomplete

Synchronous: the bot waits for the plugin's response on
`/commands/:name/autocomplete` (1.5-second budget). On timeout or
failure the bot returns an empty list.

### Components (buttons)

The plugin attaches Discord v1 buttons to messages it sends. The
`custom_id` follows the shape `kc:<pluginKey>:<componentId>` (with an
optional `:<tail>` parameter; the SDK's `componentCustomId(pluginKey, id,
tail?)` builds it). When a user clicks, the bot calls `deferUpdate()`
(3-second budget; no message change) and POSTs to the manifest's
`endpoints.plugin_component` (default `/components`) with: the clicker's
ID and display name, the voice channel they are currently in, the
plugin-scoped capabilities they hold, the message ID, and a fresh
15-minute `interaction_token`. The bot **does not wait** for the response.
The plugin replies via `interactions.respond` (PATCHes the button's
parent `@original` message) or `interactions.followup`
(`ephemeral: true`) to post a hint. Each click is a fresh interaction
with its own token, so buttons remain functional for the lifetime of the
message. SDK side: `definePluginComponent({ id, handler })`. The handler
receives a `ComponentContext` and returns
`{ content?, embeds?, components? }`, which is PATCHed onto `@original`;
returning empty or null leaves the message unchanged.

### Events

The manifest's `events_subscribed_global` (auto-merged from the SDK's
`eventHandlers` keys) plus per-feature `events_subscribed` lists the
events the plugin wants; the bot fan-outs each to the plugin's
`/events` endpoint. The SDK-side `definePlugin({ eventHandlers })`
declares handlers by event type and the SDK mounts `/events`,
verifies the HMAC, parses JSON, and dispatches — plugins do **not**
roll their own `/events` route (pre-0.4 pattern). The bot ACKs by
fire-and-forget; the plugin returns `204` immediately and runs the
handler in the background.

### Modal submit

The plugin can open a Discord modal by declaring a command with
`modal: true` and calling `ctx.sendModal(modal)` from its handler.
On submit, the bot `deferReply`s ephemerally and POSTs the form
data to the manifest's `endpoints.plugin_modal` (default
`/modals/{modal_id}`). SDK side: `definePluginModal({ id, handler })`.

### Lifecycle (guild feature toggle)

When an admin enables or disables one of the plugin's guild features,
the bot POSTs a synthetic event to the manifest's
`endpoints.plugin_lifecycle` (default `/_kc/lifecycle`) — type
`plugin.guild.enabled` or `plugin.guild.disabled`. SDK side:
`onEnable(ctx, guildId)` and `onDisable(ctx, guildId)` hooks on the
plugin config. The endpoint is HMAC-verified like the others and
only mounted when at least one hook is declared.

### Rich health probe

The bot polls `endpoints.health` (default `/health/detail`) every
60 seconds for a structured `HealthReport`. SDK side:
`definePlugin({ healthCheck })`. When no producer is configured the
SDK returns `{ status: "healthy" }` unconditionally.

## Plugin → Bot RPC

```
POST /api/plugin/<method>     header Authorization: Bearer <token>   body: JSON
```

The allowed methods are determined by the manifest's `rpcMethodsUsed` —
that list is the plugin's authorisation scope. The bot signs it into the
token at register (no admin approval step), but every RPC call still
checks the scope (a call to a method not declared in the manifest returns
403), so the plugin can only call what it has declared.

Common methods (see `src/modules/plugin-system/plugin-rpc-routes.ts` for
the full set; SDK side: `ctx.discord.*` / `ctx.voice.*` typed facade,
with `ctx.botRpc(path, body)` as escape hatch):

- `interactions.respond` and `interactions.followup`
  (`ctx.discord.interactions.respond/followup`).
- `messages.send` (may include `components` — Discord v1 action rows)
  (`ctx.discord.messages.send`).
- `messages.edit` (modify a message the bot has sent; `components: []`
  clears the buttons) (`ctx.discord.messages.edit`).
- `messages.delete` (`ctx.discord.messages.delete`).
- `messages.add_reaction` (`ctx.discord.messages.addReaction`).
- `messages.send_dm`.
- `voice.join`, `voice.play`, `voice.pause` (`{ guild_id, paused? }`;
  omitting `paused` toggles), `voice.stop`, `voice.status`, `voice.leave`
  — all available as `ctx.voice.*`.
- `members.get` (`ctx.discord.members.get`).
- `auth.session` and KV access (no typed facade yet — use `ctx.botRpc`).

`messages.send` and `messages.edit` are gated by the per-guild feature
toggle: the plugin must have at least one enabled feature in the target
channel's guild to send or edit messages there.

### Failure handling — `BotRpcError` and retry

Every `/api/plugin/*` call (via either the typed facade or
`ctx.botRpc`) throws `BotRpcError` on failure with
`reason: 'no_token' | 'network' | 'http_status'`. The SDK auto-retries
on `503` / `429` / network errors up to 3 times with exponential
backoff (200 ms base, 1.5 s cap, ±30% jitter; respects `Retry-After`).
Other `5xx` and any `4xx` (other than `429`) are surfaced immediately
because the bot may already have processed the request — plugins
must not layer their own retry on top.

### WebUI authorisation (plugin-session token)

For plugins that hand users a browser link:

1. Inside a slash command, the plugin calls
   `POST /api/plugin/auth.session` (requires the `auth.session` scope).
   The bot uses its JWT signing authority to issue a `plugin-session`
   JWT (with `userId` / `guildId` / a subset of the user's `admin` +
   `plugin:<this key>:*` capabilities) and returns it to the plugin.
2. The plugin puts the token in the WebUI link handed to the user.
3. The WebUI server receives the request and verifies the JWT
   **offline** with `sessionVerifyPublicKey` (SDK's
   `verifyPluginSession(token, publicKey)`), then derives `userId` /
   `capabilities` for its own authorisation. No round-trip to the bot.

The token is signed with the bot's Ed25519 private key; the plugin
only has the public key, so it can verify but cannot forge. An admin
can rotate the signing key in the system settings page; rotation
invalidates every existing token immediately, and plugins receive the
new public key within one heartbeat cycle.

## Plugin WebUI reverse proxy

The bot ships a reverse proxy so a plugin's WebUI can reuse the bot's
TLS certificate and public port, with no need for a separate cert or
extra exposed port.

### Routes

| Request | Behaviour |
|---------|-----------|
| `GET /plugin/<pluginKey>` | `301` redirect to `/plugin/<pluginKey>/`. |
| `ANY /plugin/<pluginKey>/*` | Proxied to the plugin's manifest-declared `url`, with the `/plugin/<pluginKey>` prefix stripped. |

Example: bot public URL `https://bot.example.com`, plugin `karyl-radio`
with `plugin.url = "http://karyl-radio-plugin:3000"`:

```
GET https://bot.example.com/plugin/karyl-radio/dashboard?tab=queue
  → forwarded to http://karyl-radio-plugin:3000/dashboard?tab=queue
```

### Authentication behaviour

`/plugin/*` routes **do not** require a bot login session. The plugin
verifies the `plugin-session` JWT itself (see
[WebUI authorisation](#webui-authorisation-plugin-session-token)).
Discord `?token=` links land directly on the path; no prior bot access
token is required.

### Proxy conditions

- The plugin's DB record must exist with `status === 'active'` (the
  plugin is currently heartbeating).
- The `enabled` flag does **not** affect the proxy. `enabled` controls
  only Discord command and event dispatch, not the plugin's own HTTP
  surface. An admin can reach a disabled plugin's WebUI without
  re-enabling its Discord commands.
- An unknown `pluginKey` or `status !== 'active'` returns
  `404 { "error": "unknown plugin" }`.
- The forwarding URL is read from the DB-stored `plugin.url` (the
  manifest-declared value). The request's host or origin is not used.

### `publicBaseUrl` — how the plugin learns its public URL

Register and heartbeat responses include a `publicBaseUrl` field:

```json
{
  "ok": true,
  "sessionVerifyPublicKey": "...",
  "publicBaseUrl": "http://localhost:902/plugin/karyl-radio"
}
```

The value is `<WEB_BASE_URL>/plugin/<pluginKey>` (trailing slash of
`WEB_BASE_URL` is trimmed). When `WEB_BASE_URL` is **not** set, the
field is omitted (no `null` or empty string).

A WebUI plugin should use `publicBaseUrl` as the browser-facing base
URL. Inject the path portion into server-rendered HTML (for example,
`<base href="/plugin/karyl-radio/">`) so the client-side `fetch` calls
and static asset paths fall under the proxy prefix.

### CSP requirements

The bot's `@fastify/helmet` sets a strict `Content-Security-Policy`
that applies to every `/plugin/*` response. If the plugin's WebUI
response carries its own `Content-Security-Policy` header, that header
overrides the bot's default (`@fastify/reply-from` forwards the
upstream's response headers to the browser). **A WebUI plugin must
send an appropriate `Content-Security-Policy` of its own.** A plugin
that omits the CSP header inherits the bot's strict default, which
blocks most inline scripts and styles.

### Limitations

- **SSE (`text/event-stream`).** Long-running SSE streams are cut off
  by the proxy's 30-second upstream timeout. A WebUI that needs
  server-sent events must reconnect before the timeout, or use a
  different channel.
- **WebSocket.** `@fastify/reply-from` does not proxy WebSocket
  `Upgrade` requests. WebSocket support requires extending the proxy.

### Benefit

The plugin no longer needs its own TLS certificate or an exposed port;
the bot's reverse proxy handles TLS termination and the public URL.

---

## Deployment

Each plugin is a Docker service attached to the bot-managed
`karyl-chan-net` external network. The plugin's environment must at
least define:

- `BOT_URL` (default `http://karyl-chan:3000`).
- `PLUGIN_URL` (sent to the bot in the manifest as the dispatch target;
  defaults to the container's hostname).
- `KARYL_PLUGIN_SETUP_SECRET` (issued by an admin).

`KARYL_PLUGIN_SETUP_SECRET` is pre-provisioned by an admin from the
bot's `/admin/plugins` page (click "New Plugin", enter the plugin's
manifest `id`, or call `POST /api/plugins/setup-secret { pluginKey }`).
The bot creates a placeholder row and returns the cleartext secret
exactly once. Put that secret into the plugin's `.env` and start it;
the plugin self-registers, and the admin enables it from
`/admin/plugins`.

## Related files

- **Bot side.** `src/modules/plugin-system/`
  (`plugin-routes.ts` for register / heartbeat,
  `plugin-interaction-dispatch.service.ts` for command dispatch,
  `plugin-event-bridge.service.ts` for event dispatch,
  `plugin-rpc-routes.ts` for RPC, `plugin-registry.service.ts` for
  registration logic, `models/plugin.model.ts`).
- **HMAC specification.** `src/utils/hmac.ts`.
- **JWT signing authority.** `src/modules/web-core/jwt.service.ts`.
- **Plugin side.** `packages/plugin-sdk/` (SDK + manifest builder +
  HMAC + `verifyPluginSession`); see
  [`packages/plugin-sdk/README.md`](../../../plugin-sdk/README.md).

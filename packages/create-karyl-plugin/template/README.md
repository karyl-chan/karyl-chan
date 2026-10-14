# **PLUGIN_NAME**

A [karyl-chan](https://github.com/karyl-chan/karyl-chan) plugin, scaffolded
with `create-karyl-plugin`. It registers one slash command,
`/__PLUGIN_KEY__-ping`, that replies `pong 🏓`.

## Quick start

### 1. Install

```bash
npm install
```

The SDK is public on npm. You do not need a GitHub PAT or a project
`.npmrc`.

### 2. Get a setup secret

A plugin can't register with the bot until an admin provisions a per-plugin
setup secret:

1. In the bot admin UI, open **Plugins**.
2. Add the `__PLUGIN_KEY__` plugin row if it does not exist.
3. **Security → Generate setup secret**, copy the value into `.env` as
   `KARYL_PLUGIN_SETUP_SECRET`.

```bash
cp .env.example .env
# Edit .env and paste the secret, then:
npm run dev
```

On the next start the plugin registers, runs its initialization, performs an
authenticated ready transition, and only then begins heartbeating and accepts
dispatch. The generated entry point waits for `started.whenReady()`, so an
`onStart` failure is visible instead of producing a half-ready service.

### 3. Approve and enable

Back in **Plugins**, approve requested RPC scopes when
`PLUGIN_AUTO_APPROVE=false`, then enable the plugin. Registration alone does
not enable dispatch. This starter requests only `interactions.respond`.

### 4. Invoke

Invoke `/__PLUGIN_KEY__-ping` in a guild where the plugin is installed. It
replies `pong 🏓`.

## Health and dark mode

Starting without `KARYL_PLUGIN_SETUP_SECRET` intentionally serves dark:

- `GET /health` returns 200 because the process is live.
- `GET /health/ready` returns 503 with `state: "serving_dark"` because the
  plugin cannot receive dispatch.

With a secret, readiness becomes 200 only after registration, transport
startup, `onStart`, and the authenticated ready transition all succeed. The
compose healthcheck uses readiness, not liveness.

## Layout

| File            | What                                                                      |
| --------------- | ------------------------------------------------------------------------- |
| `src/plugin.ts` | `definePlugin({...})` — the manifest + command handlers.                  |
| `src/index.ts`  | Entry point — calls `plugin.start()`.                                     |
| `.env.example`  | The environment contract (`BOT_URL`, setup secret, `PLUGIN_URL`, `PORT`). |

## Next steps

- Add a command: another `definePluginCommand({...})` in the
  `pluginCommands` array.
- Call the bot back: list the scope in `rpcMethodsUsed` (for example
  `"messages.send"`) and use the typed facade:

  ```ts
  await ctx.discord.messages.send({ channelId, content: "hello" });
  ```

  Use `ctx.botRpc("/api/plugin/...", body)` only as the supported low-level
  escape hatch when no typed method exists. Newly requested scopes may need
  admin approval before the token carries them.
- Subscribe to events, add buttons/modals, or a guild feature — see the
  plugin SDK docs (`packages/plugin-sdk/docs/`).

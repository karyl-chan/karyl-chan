# __PLUGIN_NAME__

A [karyl-chan](https://github.com/karyl-chan/karyl-chan) plugin, scaffolded
with `create-karyl-plugin`. It registers one slash command,
`/__PLUGIN_KEY__-ping`, that replies `pong 🏓`.

## Quick start

```bash
npm install
cp .env.example .env      # fill in BOT_URL + KARYL_PLUGIN_SETUP_SECRET
npm run dev               # tsx watch — reloads on save
```

### Get a setup secret

A plugin can't register with the bot until an admin provisions a per-plugin
setup secret:

1. In the bot admin UI, open **Plugins**.
2. Find (or pre-create) the row for `__PLUGIN_KEY__`.
3. **Security → Generate setup secret**, copy the value into `.env` as
   `KARYL_PLUGIN_SETUP_SECRET`.

On the next start the plugin registers, syncs its command to Discord, and
begins heartbeating. Invoke `/__PLUGIN_KEY__-ping` in a guild where the
plugin is installed to see `pong 🏓`.

## Layout

| File | What |
|------|------|
| `src/plugin.ts` | `definePlugin({...})` — the manifest + command handlers. |
| `src/index.ts`  | Entry point — calls `plugin.start()`. |
| `.env.example`  | The environment contract (`BOT_URL`, setup secret, `PLUGIN_URL`, `PORT`). |

## Next steps

- Add a command: another `definePluginCommand({...})` in the
  `pluginCommands` array.
- Call the bot back: list the scope in `rpcMethodsUsed` (e.g.
  `"messages.send"`) and use `ctx.botRpc` in a handler. Newly-requested
  scopes may need admin approval before the token carries them.
- Subscribe to events, add buttons/modals, or a guild feature — see the
  plugin SDK docs (`packages/plugin-sdk/docs/`).

> `.npmrc` points the `@karyl-chan` scope at GitHub Packages. You need a
> GitHub token with `read:packages` in your user `~/.npmrc` to install the
> SDK — see the comment in `.npmrc`.

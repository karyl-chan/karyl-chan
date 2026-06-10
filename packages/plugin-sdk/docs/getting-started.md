# Getting started

Goal: a running plugin that responds to a slash command, in ~10 minutes.

## 1. Scaffold

```bash
pnpm create karyl-plugin my-plugin
# or, from a checkout of this monorepo:
node packages/create-karyl-plugin/index.js my-plugin
```

This generates a minimal plugin (one command, `/my-plugin-ping` → `pong 🏓`).
See [`create-karyl-plugin`](../../create-karyl-plugin/README.md) for the
layout and flags. The rest of this guide explains what the scaffold gives
you.

## 2. Install

```bash
cd my-plugin
npm install
```

The generated `.npmrc` points the `@karyl-chan` scope at GitHub Packages.
You need a GitHub token with `read:packages` in your user `~/.npmrc` to
install the SDK — see the comment in the generated `.npmrc`.

## 3. The two files

`src/plugin.ts` — the manifest and handlers, via `definePlugin`:

```ts
import { definePlugin, definePluginCommand } from "@karyl-chan/plugin-sdk";

const ping = definePluginCommand({
  name: "my-plugin-ping",
  description: "Health check — replies with pong.",
  scope: "guild",
  integrationTypes: ["guild_install"],
  contexts: ["Guild"],
  handler: async (ctx) => {
    ctx.log.info("ping invoked");
    return "pong 🏓"; // a string is the shortest CommandReply (ephemeral)
  },
});

export const plugin = definePlugin({
  key: "my-plugin",
  name: "My Plugin",
  version: "0.1.0",
  rpcMethodsUsed: ["interactions.respond"], // scopes you call on the bot
  pluginCommands: [ping],
});
```

`src/index.ts` — the entry point, which just calls `plugin.start()`. See
the main README's [Lifecycle](../README.md#lifecycle) for everything
`start()` does.

## 4. Wire a setup secret

A plugin can't register with the bot until an admin provisions a
per-plugin **setup secret**:

1. In the bot admin UI, open **Plugins** (pre-create the `my-plugin` row if
   it isn't there yet).
2. **Security → Generate setup secret**, then put the value in `.env`:
   ```
   KARYL_PLUGIN_SETUP_SECRET=<the secret>
   BOT_URL=http://localhost:3000
   PLUGIN_URL=http://localhost:4000
   PORT=4000
   ```

Without the secret the plugin still starts its HTTP server but never
registers — no commands, no events. (This is the intended way to run a
plugin "dark" while developing its HTTP surface.)

## 5. Run

```bash
cp .env.example .env   # then fill in the secret from step 4
npm run dev            # tsx watch — reloads on save
```

On start the plugin registers, syncs `/my-plugin-ping` to Discord, and
begins heartbeating. Invoke it in a guild where the plugin is installed.

## Where to go next

- **Call the bot back.** Add a scope to `rpcMethodsUsed` (e.g.
  `"messages.send"`) and use the typed facade `ctx.discord.*` (or
  `ctx.botRpc(path, body)`). Newly-requested scopes may need admin
  approval — see [permissions.md](permissions.md).
- **React to Discord events.** Add `eventHandlers` keyed by `Events.*`
  (see the main README's [Event handlers](../README.md#event-handlers-discord-side-events)).
- **Buttons, modals, guild features, WebUI.** All covered in the main
  [README](../README.md).
- **Understand the runtime states.** See
  [plugin-lifecycle.md](plugin-lifecycle.md).

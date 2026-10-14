# Getting started

Goal: a running plugin that responds to a slash command, in ~10 minutes.

## 1. Scaffold

```bash
pnpm create karyl-plugin my-plugin
# or
npm create karyl-plugin@latest my-plugin
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

The SDK and initializer are public npm packages. A fresh machine needs no
GitHub PAT and the scaffold does not generate a registry-specific `.npmrc`.

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

## 5. Run and observe readiness

```bash
cp .env.example .env   # then fill in the secret from step 4
npm run dev            # tsx watch — reloads on save
```

On start the plugin registers, starts its selected event transport, runs
`onStart`, performs the authenticated ready transition, and begins
heartbeating. Until all of that succeeds, `/health/ready` returns 503 and the
bot excludes the endpoint from dispatch.

Without a secret, the generated entry point intentionally remains in dark
mode: `/health` returns 200 while `/health/ready` returns 503 with
`state: "serving_dark"`.

## 6. Approve and enable

In the bot admin UI, return to **Plugins**:

1. If `PLUGIN_AUTO_APPROVE=false`, review and approve the requested RPC
   scopes. The starter requests `interactions.respond`.
2. Enable the plugin. Registration alone does not enable dispatch.

## 7. Invoke

Invoke `/my-plugin-ping` in a guild where the plugin is installed. A working
deployment replies `pong 🏓`.

## Where to go next

- **Call the bot back.** Add a scope to `rpcMethodsUsed` (for example
  `"messages.send"`) and use the typed facade:

  ```ts
  await ctx.discord.messages.send({ channelId, content: "hello" });
  ```

  Use `ctx.botRpc(path, body)` only as the supported low-level escape hatch
  when no typed method exists. Newly requested scopes may need admin approval
  — see [permissions.md](permissions.md).
- **React to Discord events.** Add `eventHandlers` keyed by `Events.*`
  (see the main README's [Event handlers](../README.md#event-handlers-discord-side-events)).
- **Buttons, modals, guild features, WebUI.** All covered in the main
  [README](../README.md).
- **Understand the runtime states.** See
  [plugin-lifecycle.md](plugin-lifecycle.md).

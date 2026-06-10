import { definePlugin, definePluginCommand } from "@karyl-chan/plugin-sdk";

// A single slash command: /__PLUGIN_KEY__-ping → "pong 🏓".
// The handler returns a CommandReply — a plain string is the shortest
// form (an ephemeral reply). Return `{ content, ephemeral }` for control.
const pingCommand = definePluginCommand({
  name: "__PLUGIN_KEY__-ping",
  description: "Health check — replies with pong.",
  scope: "guild",
  integrationTypes: ["guild_install"],
  contexts: ["Guild"],
  handler: async (ctx) => {
    ctx.log.info("ping invoked");
    return "pong 🏓";
  },
});

export const plugin = definePlugin({
  key: "__PLUGIN_KEY__",
  name: "__PLUGIN_NAME__",
  version: "0.1.0",
  description: "__PLUGIN_NAME__ — a karyl-chan plugin.",
  // Scopes this plugin calls on the bot's /api/plugin/* RPC surface. A
  // command that returns a reply needs "interactions.respond". Add more
  // as you use them (messages.send, storage.kv_*, voice.*, …); the bot
  // mints the token with exactly these (subject to admin approval).
  rpcMethodsUsed: ["interactions.respond"],
  pluginCommands: [pingCommand],
});

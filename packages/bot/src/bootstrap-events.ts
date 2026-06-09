import type { Client } from "discord.js";
import { config } from "./config.js";
import { registerDmInboxEvents } from "./modules/dm-inbox/events/dm-inbox.events.js";
import { registerGuildChannelEvents } from "./modules/guild-management/events/guild-channel.events.js";
import { registerPictureOnlyChannelEvents } from "./modules/builtin-features/picture-only/picture-only-channel.events.js";
import { registerRconForwardChannelEvents } from "./modules/builtin-features/rcon-forward/rcon-forward-channel.events.js";
import { registerRoleEmojiEvents } from "./modules/builtin-features/role-emoji/role-emoji.events.js";
import { registerTodoChannelEvents } from "./modules/builtin-features/todo-channel/todo-channel.events.js";
import { registerTypingStartEvents } from "./modules/dm-inbox/events/typing-start.events.js";
import { registerVoiceStateEvents } from "./modules/bot-events/events/voice-state.events.js";
// DM message_pattern dispatch 由 MessagePatternMatcher（command-system）接管，
// 在 main.ts 的 ready handler 內呼叫 messageMatcher.register(bot)。

/**
 * Single explicit registration point for every Discord event handler
 * the bot ships. Replaces the `@discordx/importer` glob scan +
 * `@Discord/@On` decorator side-effects.
 *
 * Adding a new handler: write `registerXyzEvents(client)` in
 * src/events/xyz.events.ts (no decorators, plain `client.on(...)`),
 * import + invoke it here.
 */
// `bot` is a module-level singleton reused across resetBot() → run()
// restarts, and discord.js Client.destroy() does NOT remove listeners.
// Guard so a restart (after a transient startup failure) doesn't stack a
// second copy of every handler → events firing twice (double DM publish,
// double event dispatch, double feature processing).
let eventHandlersRegistered = false;

export function bootstrapEventHandlers(client: Client): void {
  if (eventHandlersRegistered) return;
  eventHandlersRegistered = true;
  registerDmInboxEvents(client);
  registerGuildChannelEvents(client);
  registerPictureOnlyChannelEvents(client);
  registerRconForwardChannelEvents(client);
  registerRoleEmojiEvents(client);
  registerTodoChannelEvents(client);
  // Typing events require GuildMessageTyping / DirectMessageTyping intents.
  // These are high-frequency/low-value; only register when BOT_ENABLE_TYPING=true.
  if (config.bot.enableTyping) {
    registerTypingStartEvents(client);
  }
  registerVoiceStateEvents(client);
}

/**
 * Canonical Discord-side event type names.
 *
 * The bot dispatches these exact strings as the `type` field of every
 * outbound `/events` POST. Use them as keys when declaring
 * `eventHandlers` on `definePlugin` so a typo can't silently subscribe
 * to nothing.
 *
 * Why lower-dot (`guild.message_create`) and not Discord's raw
 * `MESSAGE_CREATE`: the bot intentionally namespaces by surface
 * (`guild.*` vs `dm.*`) so plugins can subscribe to only the channel
 * types they care about without re-deriving the split.
 *
 * ```ts
 * import { definePlugin, Events } from '@karyl-chan/plugin-sdk';
 *
 * definePlugin({
 *   eventHandlers: {
 *     [Events.GuildMessageCreate]: async (ctx, data) => { … },
 *   },
 * });
 * ```
 *
 * Adding a new emitted event on the bot side is an additive manifest
 * change — add the literal here in the same release and the bot's
 * dispatch path stays in lockstep with the plugin author's surface.
 */
export const Events = {
  /** A message in a guild text channel. `data` matches the bot's
   *  `serializeMessageForPlugin` payload. */
  GuildMessageCreate: "guild.message_create",
  /** A message in a DM. Same payload shape as `GuildMessageCreate`
   *  but without `guild_id`. */
  DmMessageCreate: "dm.message_create",
  /** A reaction added to a guild message. */
  GuildMessageReactionAdd: "guild.message_reaction_add",
  /** A reaction removed from a guild message. */
  GuildMessageReactionRemove: "guild.message_reaction_remove",
} as const;

export type EventName = (typeof Events)[keyof typeof Events];

const VALID = new Set<string>(Object.values(Events));

/**
 * Plugin authors that hard-code event keys (e.g. read from config
 * files) can call this to assert the key is one the bot will emit.
 * Returns true when valid; the manifest builder calls this at build
 * time to warn on dead subscriptions.
 */
export function isCanonicalEvent(name: string): name is EventName {
  return VALID.has(name);
}

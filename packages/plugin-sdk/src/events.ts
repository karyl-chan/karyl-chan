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
  /** A message edited in a guild channel (F19). Partial-safe payload:
   *  `{ message_id, channel_id, guild_id, content, edited_at }` — content
   *  is best-effort (empty string when discord.js only gave a partial). */
  GuildMessageUpdate: "guild.message_update",
  /** A message deleted in a guild channel (F19). Ids-only payload:
   *  `{ message_id, channel_id, guild_id }` — enough to tombstone a stored
   *  copy; consumers no-op on messages they never stored. */
  GuildMessageDelete: "guild.message_delete",
  /** The bot's OWN (non-ephemeral) message in a guild channel. Opt-in —
   *  only delivered to plugins that subscribe; presence plugins keep their
   *  own sends for reply-to-self detection, while ordinary plugins never
   *  see an echo of their RPC sends. Other bots are never delivered. Same
   *  payload as `GuildMessageCreate`. */
  GuildMessageCreateSelf: "guild.message_create_self",
  /** The bot's OWN ephemeral interaction reply (visible to one user).
   *  Opt-in. Payload = `GuildMessageCreate` plus `{ ephemeral: true,
   *  visible_to }`, where `visible_to` is the invoking user's id (or
   *  null) — so a subscriber can keep that exchange out of everyone
   *  else's transcript. */
  GuildMessageCreateSelfEphemeral: "guild.message_create_self_ephemeral",
  /** A message in a DM. Same payload shape as `GuildMessageCreate`
   *  but without `guild_id`. DM events carry no guild, so only approved
   *  GLOBAL subscriptions receive them (feature routes never match). */
  DmMessageCreate: "dm.message_create",
  /** A reaction added to a guild message. */
  GuildMessageReactionAdd: "guild.message_reaction_add",
  /** A reaction removed from a guild message. */
  GuildMessageReactionRemove: "guild.message_reaction_remove",
  /** A voice state change in a guild (join / leave / move / mute …). */
  GuildVoiceStateUpdate: "guild.voice_state_update",
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

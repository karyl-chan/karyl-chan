import { Client, IntentsBitField, Partials } from "discord.js";
import { config } from "../config.js";
import { botEventLog } from "../modules/bot-events/bot-event-log.js";
import { shouldRecord } from "../modules/bot-events/bot-event-dedup.js";

/**
 * Construct the sharding-ready Discord client. Single-shard deployments
 * (default) set shardId=0, totalShards=1. Multi-shard deployments wire
 * SHARD_ID + TOTAL_SHARDS env vars (one container per shard) and
 * discord.js connects to only the shard's slice of the gateway.
 */
export function createBotClient(): Client {
  return new Client({
    shards: [config.bot.shardId],
    shardCount: config.bot.totalShards,
    intents: [
      IntentsBitField.Flags.Guilds,
      IntentsBitField.Flags.GuildMembers,
      IntentsBitField.Flags.GuildMessages,
      IntentsBitField.Flags.GuildMessageReactions,
      IntentsBitField.Flags.GuildVoiceStates,
      IntentsBitField.Flags.MessageContent,
      IntentsBitField.Flags.DirectMessages,
      IntentsBitField.Flags.DirectMessageReactions,
      // Subscribe to GUILD_EMOJIS_UPDATE / GUILD_STICKERS_UPDATE so the
      // in-process emoji + sticker caches the admin emoji picker reads
      // from stay in sync after the initial GUILD_CREATE snapshot.
      // Without this the cache slowly drifts as operators add/rename/
      // delete emojis in their servers — long-running bot deployments
      // hand stale entries to the picker, the user picks one, and
      // `message.react()` 404s with `Unknown Emoji` (10014).
      IntentsBitField.Flags.GuildExpressions,
      // Typing intents are high-frequency/low-value; opt-in via BOT_ENABLE_TYPING.
      ...(config.bot.enableTyping
        ? [
            IntentsBitField.Flags.GuildMessageTyping,
            IntentsBitField.Flags.DirectMessageTyping,
          ]
        : []),
    ],
    partials: [Partials.Message, Partials.Channel, Partials.Reaction],
  });
}

/**
 * Guard @discordjs/rest's auto token-clear behaviour.
 *
 * @discordjs/rest auto-clears its bearer token whenever ANY request
 * returns 401 (see node_modules/@discordjs/rest/dist/index.js:759 —
 * `if (status === 401 && requestData.auth) manager.setToken(null)`).
 * Discord returns 401 for many resource-specific reasons that don't
 * mean the bot token is invalid (a single user.fetch on an unknown
 * id, a sticker fetch in a guild we lost permissions in, etc.). Once
 * the token is cleared every subsequent REST call throws "Expected
 * token to be set" and the dashboard / DM features all 502 until the
 * bot is restarted.
 *
 * Workaround: wrap setToken so a null clear is rejected when we
 * still hold the original BOT_TOKEN env. If the token is genuinely
 * revoked, login() and other gateway-level handshakes fail loud; we
 * don't need REST's heuristic to second-guess that. Logged once per
 * 60s via shouldRecord so the operator notices but isn't drowned.
 */
export function patchRestSetToken(bot: Client): void {
  const realToken = config.bot.token;
  if (!realToken) return;
  const restAny = bot.rest as unknown as {
    setToken: (t: string | null) => unknown;
  };
  const origSetToken = restAny.setToken.bind(restAny);
  restAny.setToken = (t: string | null) => {
    if (t === null) {
      if (shouldRecord("rest-token-auto-clear")) {
        botEventLog.record(
          "warn",
          "bot",
          "REST.setToken(null) ignored — likely a 401 from a single resource fetch, not a real auth failure",
        );
      }
      return origSetToken(realToken);
    }
    return origSetToken(t);
  };
}

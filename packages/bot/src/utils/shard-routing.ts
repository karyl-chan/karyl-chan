/**
 * Phase 3.3 — shard routing helpers.
 *
 * Discord's gateway routes every event for a guild to a specific
 * shard determined by:
 *
 *   shardId = (BigInt(guild_id) >> 22n) % BigInt(shard_count)
 *
 * Plugin RPC calls (messages.send / voice.play / channels.fetch /
 * …) need to execute on the shard that owns the guild — otherwise
 * `bot.guilds.cache.get(guild_id)` returns null and the RPC fails
 * with "guild not found" even though another shard process holds
 * a valid handle.
 *
 * This module computes the target shard for a guild and exposes a
 * cheap "is this my shard" predicate the RPC layer can call before
 * touching the discord.js client.
 *
 * Cross-shard *forwarding* (i.e. shard 0 receives an RPC for a
 * guild shard 1 owns, and forwards the HTTP call to shard 1) is
 * NOT done here yet — it's the natural next layer but requires
 * service discovery between shards. For now, a misrouted RPC is
 * logged and falls through to the existing "guild not found"
 * response so the plugin can retry / fail loudly.
 */

import { config } from "../config.js";

/**
 * Compute the shard id (0-indexed) that owns the given Discord
 * guild. Uses BigInt arithmetic — guild IDs are 64-bit snowflakes
 * that don't fit in JS Number.
 */
export function targetShardForGuild(
  guildId: string,
  totalShards: number = config.bot.totalShards,
): number {
  if (totalShards <= 1) return 0;
  // (guildId >> 22) % shardCount — the Discord-canonical formula.
  // The right-shift extracts the timestamp portion of the snowflake;
  // dividing by 4194304 (= 2^22) is equivalent.
  return Number((BigInt(guildId) >> 22n) % BigInt(totalShards));
}

/** True if the given guild is owned by THIS shard. */
export function isMyShard(guildId: string): boolean {
  return targetShardForGuild(guildId) === config.bot.shardId;
}

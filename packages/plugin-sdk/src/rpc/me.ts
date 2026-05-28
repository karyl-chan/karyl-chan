/**
 * Typed `me.*` RPC namespace.
 *
 * Plugin-introspection calls that don't fit `discord` / `voice` / `kv`:
 * which guilds this plugin is currently active in, how much KV quota
 * it has consumed.
 *
 * `me.enabledGuilds()` is the canonical entry point for cross-guild
 * background workers (reminder, queue, digest, …). Before 0.9 the
 * underlying route was a GET that the SDK's POST-only `botRpc` could
 * never reach — bot is now POST-shaped to match.
 */

import type { RpcCaller } from "./index.js";

export interface MeKvUsageArgs {
  guildId: string;
}

export interface MeKvUsage {
  usedBytes: number;
  quotaBytes: number;
}

export interface Me {
  /**
   * Guild IDs where this plugin is currently active.
   *
   * Two-mode semantics from the manifest:
   *  - If the plugin declares ≥1 `guildFeatures`: guilds with at least
   *    one effectively-enabled feature (row → operator default →
   *    manifest `enabledByDefault` → false).
   *  - If the plugin declares NO `guildFeatures` (e.g. a featureless
   *    background worker like reminder): every guild the bot is in.
   *
   * Always reflects only guilds the bot is currently in — stale rows
   * for guilds the bot has left are filtered out.
   */
  enabledGuilds(): Promise<string[]>;
  /** Current KV usage + quota for one guild. */
  kvUsage(args: MeKvUsageArgs): Promise<MeKvUsage>;
}

export function createMe(call: RpcCaller): Me {
  return {
    async enabledGuilds() {
      const res = (await call("/api/plugin/me/enabled_guilds", {})) as {
        guild_ids?: unknown;
      };
      return Array.isArray(res.guild_ids)
        ? res.guild_ids.filter((g): g is string => typeof g === "string")
        : [];
    },
    async kvUsage(args) {
      const res = (await call("/api/plugin/me/kv_usage", {
        guild_id: args.guildId,
      })) as { used_bytes?: number; quota_bytes?: number };
      return {
        usedBytes: typeof res.used_bytes === "number" ? res.used_bytes : 0,
        quotaBytes: typeof res.quota_bytes === "number" ? res.quota_bytes : 0,
      };
    },
  };
}

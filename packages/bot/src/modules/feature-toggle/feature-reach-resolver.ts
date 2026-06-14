/**
 * FeatureReachResolver — cached, per-feature-key 3-tier reach resolution
 * (PM-8 event-reach enforcement).
 *
 * Authoritative precedence per (pluginId, guildId, featureKey):
 *   1. plugin_guild_features row — explicit per-guild override
 *   2. plugin_feature_defaults row — operator default ("All Servers")
 *   3. manifest.guild_features[].enabled_by_default — author intent
 *   4. false
 *
 * This is the ONE place runtime gates resolve feature reach:
 *   - event dispatch (feature-scoped subscriptions, hot path)
 *   - the RPC per-guild feature gate (plugin-rpc-routes)
 *   - component/modal dispatch (via feature-resolve.ts delegate)
 *
 * Cache shape: `pluginId → guildId → { features: Map<featureKey,bool> }`.
 * One cache miss triggers a single two-query DB read that resolves and
 * caches EVERY declared feature for that (plugin, guild) pair, so a
 * guild message fanning out to multiple features costs one round-trip,
 * then Map reads. Nesting by pluginId makes invalidatePlugin a single
 * `Map.delete` and invalidateGuild two lookups — O(1), not an O(cache)
 * prefix scan.
 *
 * Concurrency (single-threaded JS, but interleaved awaits):
 *   - Single-flight: concurrent misses for the same (plugin, guild)
 *     share ONE in-flight DB read instead of each firing its own — no
 *     cold-start stampede, and a transient DB error doesn't turn the
 *     dispatch hot path into a per-event retry storm.
 *   - Per-(plugin, guild) versioning closes the invalidate-during-fill
 *     race at its true grain. Each invalidate bumps a version token for
 *     exactly what it cleared: invalidateGuild bumps one guild's counter;
 *     invalidatePlugin bumps a per-plugin epoch that covers every guild,
 *     including reads in flight for guilds not yet in the cache. A
 *     resolve captures the token at its synchronous entry and caches its
 *     result only if the token is unchanged when the read returns; a
 *     joiner shares an in-flight read only if its token still matches. So
 *     a caller arriving after a toggle re-reads instead of inheriting the
 *     pre-toggle snapshot, and invalidating one guild never discards a
 *     sibling guild's concurrent fill.
 *
 * 30s TTL bounds staleness if an invalidation point is ever missed.
 * Fail-closed: a DB error resolves to false for this call and caches
 * nothing — reach is never granted unconfirmed. Callers pass an already
 * parsed manifest (memoized per row by parsePluginManifest), so the
 * resolver never parses; an unparseable manifest is the caller's gate.
 */

import { findFeatureRowsByPluginGuild } from "./models/plugin-guild-feature.model.js";
import { findFeatureDefaultsByPlugin } from "./models/plugin-feature-default.model.js";
import type { PluginManifest } from "../plugin-system/plugin-sdk-types.js";

const DEFAULT_TTL_MS = 30_000;

interface GuildEntry {
  /** Every declared feature key → its resolved enablement. A key absent
   *  from the map (not in the manifest) reads as false without re-query. */
  features: Map<string, boolean>;
  insertedAt: number;
}

interface InFlight {
  /** Version token captured when this read started; a joiner with a
   *  different token must not inherit this (now-superseded) read. */
  token: string;
  promise: Promise<Map<string, boolean> | null>;
}

export class FeatureReachResolver {
  /** pluginId → (guildId → resolved feature map). */
  private byPlugin = new Map<number, Map<string, GuildEntry>>();
  /** pluginId → epoch, bumped by invalidatePlugin (covers every guild,
   *  incl. reads in flight for guilds not yet cached). */
  private pluginEpoch = new Map<number, number>();
  /** `${pluginId}:${guildId}` → generation, bumped by invalidateGuild. */
  private guildGen = new Map<string, number>();
  /** `${pluginId}:${guildId}` → in-flight resolve (single-flight dedup). */
  private inflight = new Map<string, InFlight>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(opts: { ttlMs?: number; now?: () => number } = {}) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.now = opts.now ?? Date.now;
  }

  /** Is this specific feature effectively enabled in this guild? */
  async isFeatureEnabledInGuild(
    pluginId: number,
    guildId: string,
    featureKey: string,
    manifest: PluginManifest,
  ): Promise<boolean> {
    const map =
      this.readGuild(pluginId, guildId) ??
      (await this.resolveGuild(pluginId, guildId, manifest));
    return map?.get(featureKey) ?? false;
  }

  /**
   * Is ANY declared feature effectively enabled in this guild? A plugin
   * that declares NO guild features passes unconditionally — its only
   * per-guild surface is the plugin-level enabled flag, which callers
   * check separately (same contract feature-resolve.ts established).
   */
  async hasAnyFeatureEnabledInGuild(
    pluginId: number,
    guildId: string,
    manifest: PluginManifest,
  ): Promise<boolean> {
    const features = manifest.guild_features ?? [];
    if (features.length === 0) return true;
    const map =
      this.readGuild(pluginId, guildId) ??
      (await this.resolveGuild(pluginId, guildId, manifest));
    if (!map) return false;
    return features.some((f) => map.get(f.key) === true);
  }

  /** Drop the cached entry for one (plugin, guild) pair. */
  invalidateGuild(pluginId: number, guildId: string): void {
    const key = flightKey(pluginId, guildId);
    this.guildGen.set(key, (this.guildGen.get(key) ?? 0) + 1);
    const inner = this.byPlugin.get(pluginId);
    if (inner) {
      inner.delete(guildId);
      if (inner.size === 0) this.byPlugin.delete(pluginId);
    }
  }

  /** Drop every cached entry for a plugin (operator-default change,
   *  re-register, disable, delete). */
  invalidatePlugin(pluginId: number): void {
    this.pluginEpoch.set(pluginId, (this.pluginEpoch.get(pluginId) ?? 0) + 1);
    this.byPlugin.delete(pluginId);
  }

  /** Test/diagnostic — number of live (plugin, guild) entries. */
  size(): number {
    let n = 0;
    for (const inner of this.byPlugin.values()) n += inner.size;
    return n;
  }

  /** Test-only — drop all state (isolation between test cases). */
  clear(): void {
    this.byPlugin.clear();
    this.pluginEpoch.clear();
    this.guildGen.clear();
    this.inflight.clear();
  }

  /** The version of a (plugin, guild) — its plugin epoch and guild
   *  generation. Any invalidate that touches this pair changes it. */
  private versionToken(pluginId: number, guildId: string): string {
    const epoch = this.pluginEpoch.get(pluginId) ?? 0;
    const gen = this.guildGen.get(flightKey(pluginId, guildId)) ?? 0;
    return `${epoch}:${gen}`;
  }

  private readGuild(
    pluginId: number,
    guildId: string,
  ): Map<string, boolean> | null {
    const inner = this.byPlugin.get(pluginId);
    const entry = inner?.get(guildId);
    if (!entry) return null;
    if (this.now() - entry.insertedAt >= this.ttlMs) {
      inner!.delete(guildId);
      if (inner!.size === 0) this.byPlugin.delete(pluginId);
      return null;
    }
    return entry.features;
  }

  /** Single-flight wrapper: concurrent misses for the same version share
   *  one DB read; a miss whose version moved on (an invalidate landed)
   *  starts its own read rather than inheriting a superseded one. */
  private resolveGuild(
    pluginId: number,
    guildId: string,
    manifest: PluginManifest,
  ): Promise<Map<string, boolean> | null> {
    const key = flightKey(pluginId, guildId);
    // Capture the version at the SYNCHRONOUS entry, before any await.
    const token = this.versionToken(pluginId, guildId);
    const existing = this.inflight.get(key);
    if (existing && existing.token === token) return existing.promise;
    const promise = this.doResolve(pluginId, guildId, manifest, token).finally(
      () => {
        // Clear only if we are still the current flight — a fresher read
        // (started after an invalidate) may have replaced us.
        if (this.inflight.get(key)?.promise === promise) {
          this.inflight.delete(key);
        }
      },
    );
    this.inflight.set(key, { token, promise });
    return promise;
  }

  private async doResolve(
    pluginId: number,
    guildId: string,
    manifest: PluginManifest,
    token: string,
  ): Promise<Map<string, boolean> | null> {
    let rows: Awaited<ReturnType<typeof findFeatureRowsByPluginGuild>>;
    let defaults: Awaited<ReturnType<typeof findFeatureDefaultsByPlugin>>;
    try {
      [rows, defaults] = await Promise.all([
        findFeatureRowsByPluginGuild(pluginId, guildId),
        findFeatureDefaultsByPlugin(pluginId),
      ]);
    } catch {
      return null;
    }
    // Defensive: a misbehaving store (or a partial test stub) resolving
    // non-arrays must not crash the dispatch hot path.
    if (!Array.isArray(rows)) rows = [];
    if (!Array.isArray(defaults)) defaults = [];
    const rowByKey = new Map(rows.map((r) => [r.featureKey, r.enabled]));
    const defaultByKey = new Map(defaults.map((d) => [d.featureKey, d.enabled]));
    const features = new Map<string, boolean>();
    for (const feature of manifest.guild_features ?? []) {
      features.set(
        feature.key,
        rowByKey.get(feature.key) ??
          defaultByKey.get(feature.key) ??
          !!feature.enabled_by_default,
      );
    }
    // Cache only if no invalidation for this (plugin, guild) happened
    // while the read was in flight — otherwise a stale snapshot would
    // re-pin a value the mutation just cleared (the race the token
    // closes). A sibling guild's invalidation does not change THIS
    // guild's token, so it never discards this fill.
    if (this.versionToken(pluginId, guildId) === token) {
      let inner = this.byPlugin.get(pluginId);
      if (!inner) {
        inner = new Map();
        this.byPlugin.set(pluginId, inner);
      }
      inner.set(guildId, { features, insertedAt: this.now() });
    }
    return features;
  }
}

/** Cache/flight key for a (plugin, guild) pair. guildId is a Discord
 *  snowflake (digits only), so `${pluginId}:${guildId}` is collision-free. */
function flightKey(pluginId: number, guildId: string): string {
  return `${pluginId}:${guildId}`;
}

/** Process-wide singleton — invalidation points live in plugin-routes
 *  (feature mutations) and plugin-event-bridge (plugin lifecycle). */
export const featureReachResolver = new FeatureReachResolver();

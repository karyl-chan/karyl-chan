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
 * Hot-path shape: one cache miss triggers a single two-query DB read
 * that resolves and caches EVERY feature key for that (plugin, guild)
 * pair, so a guild message fanning out to multiple features costs one
 * round-trip, then Map reads. 30s TTL bounds staleness if an
 * invalidation point is ever missed; mutations call the invalidate
 * methods for immediate effect (same idiom as plugin-lookup-cache).
 *
 * Fail-closed: a DB error resolves to false for this call and caches
 * nothing, so the next call retries — an event is never delivered (nor
 * an RPC allowed) on unconfirmed reach.
 */

import { findFeatureRowsByPluginGuild } from "./models/plugin-guild-feature.model.js";
import { findFeatureDefaultsByPlugin } from "./models/plugin-feature-default.model.js";
import type { PluginManifest } from "../plugin-system/plugin-sdk-types.js";

const DEFAULT_TTL_MS = 30_000;

interface CacheEntry {
  value: boolean;
  insertedAt: number;
}

export class FeatureReachResolver {
  /** `${pluginId}:${guildId}:${featureKey}` → resolved enablement. */
  private cache = new Map<string, CacheEntry>();
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
    const cached = this.read(pluginId, guildId, featureKey);
    if (cached !== null) return cached;
    await this.resolveGuild(pluginId, guildId, manifest);
    return this.read(pluginId, guildId, featureKey) ?? false;
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
    // Fast path: any cached true short-circuits without touching the DB.
    let allCached = true;
    for (const f of features) {
      const cached = this.read(pluginId, guildId, f.key);
      if (cached === true) return true;
      if (cached === null) allCached = false;
    }
    if (allCached) return false;
    await this.resolveGuild(pluginId, guildId, manifest);
    return features.some(
      (f) => this.read(pluginId, guildId, f.key) === true,
    );
  }

  /** Drop cached entries for one (plugin, guild) pair. */
  invalidateGuild(pluginId: number, guildId: string): void {
    const prefix = `${pluginId}:${guildId}:`;
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) this.cache.delete(key);
    }
  }

  /** Drop every cached entry for a plugin (operator-default change,
   *  re-register, disable, delete). */
  invalidatePlugin(pluginId: number): void {
    const prefix = `${pluginId}:`;
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) this.cache.delete(key);
    }
  }

  /** Test/diagnostic — number of live cache entries. */
  size(): number {
    return this.cache.size;
  }

  /** Test-only — drop the whole cache (isolation between test cases). */
  clear(): void {
    this.cache.clear();
  }

  private read(
    pluginId: number,
    guildId: string,
    featureKey: string,
  ): boolean | null {
    const entry = this.cache.get(`${pluginId}:${guildId}:${featureKey}`);
    if (!entry) return null;
    if (this.now() - entry.insertedAt >= this.ttlMs) {
      this.cache.delete(`${pluginId}:${guildId}:${featureKey}`);
      return null;
    }
    return entry.value;
  }

  /**
   * One two-query round-trip resolves and caches every declared feature
   * key for (plugin, guild). Errors cache nothing (fail-closed retry).
   */
  private async resolveGuild(
    pluginId: number,
    guildId: string,
    manifest: PluginManifest,
  ): Promise<void> {
    let rows: Awaited<ReturnType<typeof findFeatureRowsByPluginGuild>>;
    let defaults: Awaited<ReturnType<typeof findFeatureDefaultsByPlugin>>;
    try {
      [rows, defaults] = await Promise.all([
        findFeatureRowsByPluginGuild(pluginId, guildId),
        findFeatureDefaultsByPlugin(pluginId),
      ]);
    } catch {
      return;
    }
    // Defensive: a misbehaving store (or a partial test stub) resolving
    // non-arrays must not crash the dispatch hot path.
    if (!Array.isArray(rows)) rows = [];
    if (!Array.isArray(defaults)) defaults = [];
    const rowByKey = new Map(rows.map((r) => [r.featureKey, r.enabled]));
    const defaultByKey = new Map(defaults.map((d) => [d.featureKey, d.enabled]));
    const insertedAt = this.now();
    for (const feature of manifest.guild_features ?? []) {
      const value =
        rowByKey.get(feature.key) ??
        defaultByKey.get(feature.key) ??
        !!feature.enabled_by_default;
      this.cache.set(`${pluginId}:${guildId}:${feature.key}`, {
        value,
        insertedAt,
      });
    }
  }
}

/** Process-wide singleton — invalidation points live in plugin-routes
 *  (feature mutations) and plugin-event-bridge (plugin lifecycle). */
export const featureReachResolver = new FeatureReachResolver();

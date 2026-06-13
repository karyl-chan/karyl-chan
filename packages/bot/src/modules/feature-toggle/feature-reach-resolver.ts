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
 *   - Generation guard: a per-plugin counter is bumped on every
 *     invalidate; a resolve captures it at the synchronous entry and
 *     only writes the cache if it's unchanged when the DB read returns.
 *     This closes the invalidate-during-fill race — a resolve whose read
 *     started before a feature toggle can no longer re-pin the stale
 *     value AFTER the mutation's invalidate ran (the invalidate would
 *     otherwise be a no-op against an empty cache).
 *
 * 30s TTL bounds staleness if an invalidation point is ever missed.
 * Fail-closed: a DB error (or unparseable manifest) resolves to false
 * for this call and caches nothing — reach is never granted unconfirmed.
 */

import { findFeatureRowsByPluginGuild } from "./models/plugin-guild-feature.model.js";
import { findFeatureDefaultsByPlugin } from "./models/plugin-feature-default.model.js";
import type { PluginManifest } from "../plugin-system/plugin-sdk-types.js";

const DEFAULT_TTL_MS = 30_000;

/**
 * Manifest the resolver needs only on a cache MISS (to know which
 * features exist + their defaults). A thunk lets the hot dispatch path
 * defer the `JSON.parse(manifestJson)` until it's actually needed — a
 * warm-cache event pays zero parse.
 */
type ManifestSource = PluginManifest | (() => PluginManifest | null);

interface GuildEntry {
  /** Every declared feature key → its resolved enablement. A key absent
   *  from the map (not in the manifest) reads as false without re-query. */
  features: Map<string, boolean>;
  insertedAt: number;
}

export class FeatureReachResolver {
  /** pluginId → (guildId → resolved feature map). */
  private byPlugin = new Map<number, Map<string, GuildEntry>>();
  /** pluginId → invalidation generation (bumped on every invalidate). */
  private generation = new Map<number, number>();
  /** `${pluginId}:${guildId}` → in-flight resolve (single-flight dedup).
   *  pluginId is a number so the first ':' unambiguously splits the key. */
  private inflight = new Map<string, Promise<Map<string, boolean> | null>>();
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
    manifest: ManifestSource,
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
    this.bumpGeneration(pluginId);
    this.byPlugin.get(pluginId)?.delete(guildId);
  }

  /** Drop every cached entry for a plugin (operator-default change,
   *  re-register, disable, delete). */
  invalidatePlugin(pluginId: number): void {
    this.bumpGeneration(pluginId);
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
    this.generation.clear();
    this.inflight.clear();
  }

  private bumpGeneration(pluginId: number): void {
    this.generation.set(pluginId, (this.generation.get(pluginId) ?? 0) + 1);
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
      return null;
    }
    return entry.features;
  }

  /** Single-flight wrapper: concurrent misses share one DB read. */
  private resolveGuild(
    pluginId: number,
    guildId: string,
    manifest: ManifestSource,
  ): Promise<Map<string, boolean> | null> {
    const flightKey = `${pluginId}:${guildId}`;
    const existing = this.inflight.get(flightKey);
    if (existing) return existing;
    // Capture the generation at the SYNCHRONOUS entry, before any await.
    const genAtStart = this.generation.get(pluginId) ?? 0;
    const promise = this.doResolve(
      pluginId,
      guildId,
      manifest,
      genAtStart,
    ).finally(() => {
      this.inflight.delete(flightKey);
    });
    this.inflight.set(flightKey, promise);
    return promise;
  }

  private async doResolve(
    pluginId: number,
    guildId: string,
    manifestSource: ManifestSource,
    genAtStart: number,
  ): Promise<Map<string, boolean> | null> {
    const manifest =
      typeof manifestSource === "function" ? manifestSource() : manifestSource;
    if (!manifest) return null;
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
    // Only cache if no invalidation for this plugin happened while the
    // read was in flight — otherwise a stale snapshot would re-pin a
    // value the mutation just cleared (the race the generation closes).
    if ((this.generation.get(pluginId) ?? 0) === genAtStart) {
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

/** Process-wide singleton — invalidation points live in plugin-routes
 *  (feature mutations) and plugin-event-bridge (plugin lifecycle). */
export const featureReachResolver = new FeatureReachResolver();

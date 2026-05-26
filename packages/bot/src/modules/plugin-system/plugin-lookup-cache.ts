/**
 * Hot-path cache for `findPluginByKey` (Phase 0.5).
 *
 * Plugin reverse proxy + dispatch lookups hit the plugins table on
 * every request. At single-digit-guild scale the SQLite query cost
 * disappears in the noise; at 2500-guild scale the same lookup is
 * the hot path for both anonymous WebUI traffic and plugin → bot RPC
 * authorization. This cache pins the row in memory between explicit
 * invalidations (register / setEnabled / delete / heartbeat-expire)
 * and TTL-expires anything older than CACHE_TTL_MS to bound staleness
 * in the face of a missed invalidation.
 *
 * Invalidation is the loader's responsibility — callers pass a
 * `loader` and the cache stays out of the persistence layer entirely.
 * The actual subscribe to lifecycle events happens in
 * plugin-event-bridge.service.ts (cleanest place to wire invalidators
 * — all lifecycle paths already touch it).
 */

import type { PluginRow } from "./models/plugin.model.js";

/** Bounded lifetime even without an explicit invalidate — defence
 *  against a missed lifecycle signal. */
const CACHE_TTL_MS = 30_000;

interface Entry {
  row: PluginRow | null;
  insertedAt: number;
}

const cache = new Map<string, Entry>();

/**
 * Read-through cache: returns the row (or `null` for "no such plugin")
 * either from memory or by invoking the loader on a miss. Negative
 * results are cached for the same TTL — a 404 to an unknown key
 * shouldn't punish the DB.
 */
export async function getCachedPluginByKey(
  pluginKey: string,
  loader: (key: string) => Promise<PluginRow | null>,
): Promise<PluginRow | null> {
  const hit = cache.get(pluginKey);
  const now = Date.now();
  if (hit && now - hit.insertedAt < CACHE_TTL_MS) {
    return hit.row;
  }
  const row = await loader(pluginKey);
  cache.set(pluginKey, { row, insertedAt: now });
  return row;
}

/** Invalidate one plugin's cache entry. Cheap; safe to over-invoke. */
export function invalidatePluginByKey(pluginKey: string): void {
  cache.delete(pluginKey);
}

/**
 * Invalidate by id — used by paths that only know the numeric id
 * (heartbeat reaper, lifecycle dispatch). Walks the cache; n is
 * bounded by the plugin count (small).
 */
export function invalidatePluginById(pluginId: number): void {
  for (const [key, entry] of cache) {
    if (entry.row?.id === pluginId) cache.delete(key);
  }
}

/** Drop everything — e.g. on tests / hot reload. */
export function invalidateAllPluginCache(): void {
  cache.clear();
}

/** Test-only — internal stats. */
export function __pluginCacheStatsForTests(): {
  size: number;
  entries: Array<{ key: string; hasRow: boolean; ageMs: number }>;
} {
  const now = Date.now();
  return {
    size: cache.size,
    entries: Array.from(cache.entries()).map(([key, e]) => ({
      key,
      hasRow: e.row !== null,
      ageMs: now - e.insertedAt,
    })),
  };
}

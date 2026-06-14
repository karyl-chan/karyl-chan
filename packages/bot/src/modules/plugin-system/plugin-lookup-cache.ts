/**
 * Hot-path cache for `findPluginByKey`.
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
 * In-flight loads, keyed by pluginKey. Two roles:
 *   - Single-flight: concurrent misses for the same key share ONE loader
 *     call instead of each hitting the DB — no cold-start / post-
 *     invalidate stampede at 2500-guild scale.
 *   - Invalidate-during-fill guard: an invalidation deletes the key's
 *     in-flight slot, and a load only writes the cache if its own slot is
 *     still present when it returns. So a mutation that lands mid-load
 *     can't be masked by the load re-pinning the just-cleared row for the
 *     full TTL. (The slot identity IS the generation signal — no separate
 *     counter needed.)
 */
interface InFlight {
  /** Per-load identity. The load caches only while THIS token is still
   *  the installed one, so an invalidation that dropped the slot wins. */
  token: object;
  promise: Promise<PluginRow | null>;
}
const inflight = new Map<string, InFlight>();

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
  if (hit && Date.now() - hit.insertedAt < CACHE_TTL_MS) {
    return hit.row;
  }
  const existing = inflight.get(pluginKey);
  if (existing) return existing.promise;
  const token = {};
  const promise = (async () => {
    try {
      const row = await loader(pluginKey);
      // Cache only if no invalidation replaced/cleared our slot meanwhile.
      if (inflight.get(pluginKey)?.token === token) {
        cache.set(pluginKey, { row, insertedAt: Date.now() });
      }
      return row;
    } finally {
      if (inflight.get(pluginKey)?.token === token) inflight.delete(pluginKey);
    }
  })();
  inflight.set(pluginKey, { token, promise });
  return promise;
}

/** Invalidate one plugin's cache entry. Cheap; safe to over-invoke. */
export function invalidatePluginByKey(pluginKey: string): void {
  cache.delete(pluginKey);
  inflight.delete(pluginKey);
}

/**
 * Invalidate by id — used by paths that only know the numeric id
 * (heartbeat reaper, lifecycle dispatch). Walks the cache; n is
 * bounded by the plugin count (small).
 */
export function invalidatePluginById(pluginId: number): void {
  for (const [key, entry] of cache) {
    if (entry.row?.id === pluginId) {
      cache.delete(key);
      inflight.delete(key);
    }
  }
}

/** Drop everything — e.g. on tests / hot reload. */
export function invalidateAllPluginCache(): void {
  cache.clear();
  inflight.clear();
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

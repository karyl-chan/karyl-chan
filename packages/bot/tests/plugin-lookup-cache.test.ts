/**
 * Proxy/lookup cache for findPluginByKey.
 *
 * Tests the loader-driven read-through + invalidate contract. No DB —
 * the loader stub records calls so we can assert hit/miss directly.
 */

import { describe, expect, it, beforeEach, vi } from "vitest";
import {
  __pluginCacheStatsForTests,
  getCachedPluginByKey,
  invalidateAllPluginCache,
  invalidatePluginById,
  invalidatePluginByKey,
} from "../src/modules/plugin-system/plugin-lookup-cache.js";
import type { PluginRow } from "../src/modules/plugin-system/models/plugin.model.js";

function row(p: { id: number; pluginKey: string; url?: string }): PluginRow {
  return {
    id: p.id,
    pluginKey: p.pluginKey,
    name: p.pluginKey,
    version: "0",
    url: p.url ?? "http://x",
    manifestJson: "{}",
    enabled: true,
    status: "active",
    lastHeartbeatAt: new Date(),
  } as unknown as PluginRow;
}

beforeEach(() => {
  invalidateAllPluginCache();
});

describe("plugin lookup cache", () => {
  it("hits the loader on first miss, returns cached row on second call", async () => {
    const loader = vi.fn(async (key: string) =>
      row({ id: 1, pluginKey: key }),
    );
    const a = await getCachedPluginByKey("p", loader);
    const b = await getCachedPluginByKey("p", loader);
    expect(a?.id).toBe(1);
    expect(b?.id).toBe(1);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("caches the null result so a 404 doesn't punish the DB", async () => {
    const loader = vi.fn(async () => null);
    await getCachedPluginByKey("ghost", loader);
    await getCachedPluginByKey("ghost", loader);
    await getCachedPluginByKey("ghost", loader);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("invalidatePluginByKey forces the next call to re-fetch", async () => {
    let counter = 0;
    const loader = vi.fn(async (key: string) =>
      row({ id: ++counter, pluginKey: key }),
    );
    const a = await getCachedPluginByKey("p", loader);
    invalidatePluginByKey("p");
    const b = await getCachedPluginByKey("p", loader);
    expect(a?.id).toBe(1);
    expect(b?.id).toBe(2);
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("invalidatePluginById walks the cache and drops matching entries", async () => {
    const loader = vi.fn(async (key: string) =>
      row({ id: key === "a" ? 10 : 20, pluginKey: key }),
    );
    await getCachedPluginByKey("a", loader);
    await getCachedPluginByKey("b", loader);
    expect(__pluginCacheStatsForTests().size).toBe(2);
    invalidatePluginById(10);
    expect(__pluginCacheStatsForTests().size).toBe(1);
    // 'a' is gone; next read re-loads.
    await getCachedPluginByKey("a", loader);
    expect(loader).toHaveBeenCalledTimes(3);
  });

  it("invalidateAllPluginCache empties the map", async () => {
    const loader = vi.fn(async (key: string) =>
      row({ id: 1, pluginKey: key }),
    );
    await getCachedPluginByKey("p1", loader);
    await getCachedPluginByKey("p2", loader);
    expect(__pluginCacheStatsForTests().size).toBe(2);
    invalidateAllPluginCache();
    expect(__pluginCacheStatsForTests().size).toBe(0);
  });

  it("expires entries older than 30s on read", async () => {
    vi.useFakeTimers();
    try {
      const t0 = new Date("2026-05-27T00:00:00Z").getTime();
      vi.setSystemTime(t0);
      let counter = 0;
      const loader = vi.fn(async (key: string) =>
        row({ id: ++counter, pluginKey: key }),
      );
      const a = await getCachedPluginByKey("p", loader);
      vi.setSystemTime(t0 + 30_001);
      const b = await getCachedPluginByKey("p", loader);
      expect(a?.id).toBe(1);
      expect(b?.id).toBe(2);
      expect(loader).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

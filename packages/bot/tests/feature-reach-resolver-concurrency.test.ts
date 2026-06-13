/**
 * PM-8 — FeatureReachResolver concurrency invariants (review-fix).
 *
 * The single-flight dedup, the invalidate-during-fill generation guard,
 * and fail-closed-without-caching are RACE behaviors — they can only be
 * exercised by controlling exactly when the DB read resolves. So the two
 * model queries are mocked with hand-gated promises here; the
 * sqlite-backed precedence/TTL/invalidation tests live in
 * feature-reach-resolver.test.ts.
 */
import { vi, describe, it, expect, beforeEach } from "vitest";

// Hoisted so the (hoisted) vi.mock factories can close over them.
const { findRows, findDefaults } = vi.hoisted(() => ({
  findRows: vi.fn(),
  findDefaults: vi.fn(),
}));

vi.mock(
  "../src/modules/feature-toggle/models/plugin-guild-feature.model.js",
  () => ({ findFeatureRowsByPluginGuild: findRows }),
);
vi.mock(
  "../src/modules/feature-toggle/models/plugin-feature-default.model.js",
  () => ({ findFeatureDefaultsByPlugin: findDefaults }),
);

import { FeatureReachResolver } from "../src/modules/feature-toggle/feature-reach-resolver.js";
import type { PluginManifest } from "../src/modules/plugin-system/plugin-sdk-types.js";

const PLUGIN_ID = 7;
const GUILD = "g1";
const manifest = {
  plugin: { id: "p", name: "p", version: "0", url: "http://x" },
  guild_features: [{ key: "f", name: "f", enabled_by_default: false }],
} as unknown as PluginManifest;

/** A promise resolved/rejected by hand, to gate the mocked DB read. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  findRows.mockReset();
  findDefaults.mockReset();
  findDefaults.mockResolvedValue([]); // no operator defaults unless overridden
});

describe("FeatureReachResolver — single-flight", () => {
  it("concurrent misses for the same (plugin,guild) share ONE db read", async () => {
    const r = new FeatureReachResolver();
    const gate = deferred<{ featureKey: string; enabled: boolean }[]>();
    findRows.mockReturnValue(gate.promise);

    // Both calls enter while the read is still in flight.
    const a = r.isFeatureEnabledInGuild(PLUGIN_ID, GUILD, "f", manifest);
    const b = r.isFeatureEnabledInGuild(PLUGIN_ID, GUILD, "f", manifest);
    expect(findRows).toHaveBeenCalledTimes(1);

    gate.resolve([{ featureKey: "f", enabled: true }]);
    expect(await a).toBe(true);
    expect(await b).toBe(true);
    // One shared read, one cached entry — no cold-start stampede.
    expect(findRows).toHaveBeenCalledTimes(1);
    expect(r.size()).toBe(1);
  });
});

describe("FeatureReachResolver — generation guard", () => {
  it("an invalidate mid-flight keeps the stale snapshot out of the cache", async () => {
    const r = new FeatureReachResolver();
    const gate = deferred<{ featureKey: string; enabled: boolean }[]>();
    findRows.mockReturnValueOnce(gate.promise);

    // Read starts and captures generation 0…
    const inflight = r.isFeatureEnabledInGuild(PLUGIN_ID, GUILD, "f", manifest);
    // …a feature toggle invalidates the plugin mid-flight (bumps gen)…
    r.invalidatePlugin(PLUGIN_ID);
    // …then the in-flight read returns the now-stale snapshot.
    gate.resolve([{ featureKey: "f", enabled: true }]);
    expect(await inflight).toBe(true); // the in-flight caller still gets an answer
    // …but it must NOT be cached: the value the mutation just cleared
    // cannot be re-pinned behind its back.
    expect(r.size()).toBe(0);

    // The next call therefore re-reads fresh state.
    findRows.mockResolvedValueOnce([{ featureKey: "f", enabled: false }]);
    expect(
      await r.isFeatureEnabledInGuild(PLUGIN_ID, GUILD, "f", manifest),
    ).toBe(false);
    expect(findRows).toHaveBeenCalledTimes(2);
    expect(r.size()).toBe(1);
  });
});

describe("FeatureReachResolver — fail-closed", () => {
  it("a DB error resolves false, caches nothing, and the next call retries", async () => {
    const r = new FeatureReachResolver();
    findRows.mockRejectedValueOnce(new Error("SQLITE_BUSY"));

    expect(
      await r.isFeatureEnabledInGuild(PLUGIN_ID, GUILD, "f", manifest),
    ).toBe(false);
    expect(r.size()).toBe(0); // nothing pinned on an unconfirmed read

    // Recovery: the next read succeeds and is cached normally.
    findRows.mockResolvedValueOnce([{ featureKey: "f", enabled: true }]);
    expect(
      await r.isFeatureEnabledInGuild(PLUGIN_ID, GUILD, "f", manifest),
    ).toBe(true);
    expect(findRows).toHaveBeenCalledTimes(2);
    expect(r.size()).toBe(1);
  });

  it("the single-flight entry is cleared after a failure so the next call is not wedged", async () => {
    const r = new FeatureReachResolver();
    findRows.mockRejectedValueOnce(new Error("boom"));
    await r.isFeatureEnabledInGuild(PLUGIN_ID, GUILD, "f", manifest);
    // A fresh read must actually fire (inflight map was cleared in finally).
    findRows.mockResolvedValueOnce([{ featureKey: "f", enabled: true }]);
    expect(
      await r.isFeatureEnabledInGuild(PLUGIN_ID, GUILD, "f", manifest),
    ).toBe(true);
    expect(findRows).toHaveBeenCalledTimes(2);
  });
});

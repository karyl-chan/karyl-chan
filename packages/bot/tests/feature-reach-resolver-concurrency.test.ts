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
  it("a caller that joins AFTER an invalidate re-reads instead of inheriting the stale in-flight value", async () => {
    const r = new FeatureReachResolver();
    const gateA = deferred<{ featureKey: string; enabled: boolean }[]>();
    findRows.mockReturnValueOnce(gateA.promise); // caller A's (pre-toggle) read

    // Caller A starts the read (token captured at the current version)…
    const a = r.isFeatureEnabledInGuild(PLUGIN_ID, GUILD, "f", manifest);
    expect(findRows).toHaveBeenCalledTimes(1);

    // …a feature toggle for THIS guild invalidates mid-flight…
    r.invalidateGuild(PLUGIN_ID, GUILD);

    // …caller B arrives strictly after the invalidate. It must NOT join
    // A's now-superseded read — it starts its own.
    const gateB = deferred<{ featureKey: string; enabled: boolean }[]>();
    findRows.mockReturnValueOnce(gateB.promise);
    const b = r.isFeatureEnabledInGuild(PLUGIN_ID, GUILD, "f", manifest);
    expect(findRows).toHaveBeenCalledTimes(2);

    gateA.resolve([{ featureKey: "f", enabled: true }]); // stale snapshot
    gateB.resolve([{ featureKey: "f", enabled: false }]); // post-toggle truth
    expect(await a).toBe(true); // the originator still gets an answer
    expect(await b).toBe(false); // the joiner sees the post-invalidate value
  });

  it("invalidating one guild does not discard a concurrent sibling guild's fill", async () => {
    const r = new FeatureReachResolver();
    const gateB = deferred<{ featureKey: string; enabled: boolean }[]>();
    findRows.mockReturnValue(gateB.promise);

    // A cold resolve for guild gB is in flight…
    const b = r.isFeatureEnabledInGuild(PLUGIN_ID, "gB", "f", manifest);
    // …an unrelated toggle invalidates guild gA of the SAME plugin.
    r.invalidateGuild(PLUGIN_ID, "gA");
    // gB's read returns; per-(plugin,guild) versioning must still cache it
    // (per-plugin generation would have discarded it — size 0).
    gateB.resolve([{ featureKey: "f", enabled: true }]);
    expect(await b).toBe(true);
    expect(r.size()).toBe(1);
  });

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

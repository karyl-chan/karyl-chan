/**
 * Plugin Change notifier (#27) — the seam between mutation owners and
 * the caches that react to mutations. Mutation owners emit
 * `{pluginId, guildId?, row?}`; subscribers (the feature-reach cache,
 * the event-dispatch index) invalidate/re-index themselves. This file
 * locks the notifier contract: synchronous fan-out, per-subscriber
 * error isolation, unsubscribe.
 *
 * The subscribers' own reactions are covered where they live:
 * feature-reach-resolver.test.ts (cache invalidation) and
 * plugin-event-bridge.test.ts (index updates).
 */
import { describe, it, expect, vi } from "vitest";

import {
  emitPluginChange,
  onPluginChange,
  type PluginChange,
} from "../src/modules/plugin-system/plugin-changes.js";

describe("plugin-changes notifier", () => {
  it("fans an emit out to every subscriber, synchronously", () => {
    const seenA: PluginChange[] = [];
    const seenB: PluginChange[] = [];
    const offA = onPluginChange((c) => seenA.push(c));
    const offB = onPluginChange((c) => seenB.push(c));
    try {
      emitPluginChange({ pluginId: 7, guildId: "g1" });
      expect(seenA).toEqual([{ pluginId: 7, guildId: "g1" }]);
      expect(seenB).toEqual([{ pluginId: 7, guildId: "g1" }]);
    } finally {
      offA();
      offB();
    }
  });

  it("a throwing subscriber neither breaks the emitter nor starves later subscribers", () => {
    const seen: PluginChange[] = [];
    const offBad = onPluginChange(() => {
      throw new Error("subscriber bug");
    });
    const offGood = onPluginChange((c) => seen.push(c));
    try {
      expect(() => emitPluginChange({ pluginId: 1 })).not.toThrow();
      expect(seen).toEqual([{ pluginId: 1 }]);
    } finally {
      offBad();
      offGood();
    }
  });

  it("unsubscribe stops delivery; double-unsubscribe is a no-op", () => {
    const fn = vi.fn();
    const off = onPluginChange(fn);
    emitPluginChange({ pluginId: 2 });
    off();
    off();
    emitPluginChange({ pluginId: 2 });
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

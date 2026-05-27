/**
 * Incremental event-index updates without a full table scan.
 *
 * Tests the pure `EventIndex` + `collectSubscribedEvents` /
 * `parseManifestJson` helpers in plugin-event-index.ts. The bridge
 * module wires these into the DB-driven flow; the logic itself is
 * pure and verifiable without sqlite3 / sequelize loaded.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  EventIndex,
  collectSubscribedEvents,
  parseManifestJson,
} from "../src/modules/plugin-system/plugin-event-index.js";
import type { PluginManifest } from "../src/modules/plugin-system/plugin-sdk-types.js";

function manifest(m: Partial<PluginManifest>): PluginManifest {
  return {
    plugin: { id: "p", name: "p", version: "0", url: "http://x" },
    ...m,
  } as PluginManifest;
}

function applyForPlugin(idx: EventIndex, id: number, m: PluginManifest): void {
  idx.applyPlugin(id, collectSubscribedEvents(m));
}

function readIndex(idx: EventIndex): {
  forward: Record<string, number[]>;
  perPlugin: Record<number, string[]>;
} {
  const snap = idx.snapshot();
  const forward: Record<string, number[]> = {};
  for (const [ev, ids] of snap.map) forward[ev] = Array.from(ids).sort();
  const perPlugin: Record<number, string[]> = {};
  for (const [id, evs] of snap.perPlugin) perPlugin[id] = Array.from(evs).sort();
  return { forward, perPlugin };
}

describe("EventIndex incremental update", () => {
  let idx: EventIndex;
  beforeEach(() => {
    idx = new EventIndex();
  });

  it("adds entries from a fresh applyPlugin", () => {
    applyForPlugin(
      idx,
      1,
      manifest({ events_subscribed_global: ["guild.message_create"] }),
    );
    const x = readIndex(idx);
    expect(x.forward["guild.message_create"]).toEqual([1]);
    expect(x.perPlugin[1]).toEqual(["guild.message_create"]);
    expect(idx.subscribers("guild.message_create")).toEqual([1]);
    expect(idx.hasSubscribers("guild.message_create")).toBe(true);
  });

  it("replaces a plugin's subscriptions on re-apply (removes stale, adds new)", () => {
    applyForPlugin(
      idx,
      1,
      manifest({
        events_subscribed_global: [
          "guild.message_create",
          "guild.message_reaction_add",
        ],
      }),
    );
    expect(readIndex(idx).forward["guild.message_create"]).toEqual([1]);
    expect(readIndex(idx).forward["guild.message_reaction_add"]).toEqual([1]);

    applyForPlugin(
      idx,
      1,
      manifest({ events_subscribed_global: ["guild.voice_state_update"] }),
    );
    const x = readIndex(idx);
    expect(x.forward["guild.message_create"]).toBeUndefined();
    expect(x.forward["guild.message_reaction_add"]).toBeUndefined();
    expect(x.forward["guild.voice_state_update"]).toEqual([1]);
    expect(x.perPlugin[1]).toEqual(["guild.voice_state_update"]);
  });

  it("keeps other plugins' entries intact when one re-applies", () => {
    applyForPlugin(
      idx,
      1,
      manifest({ events_subscribed_global: ["guild.message_create"] }),
    );
    applyForPlugin(
      idx,
      2,
      manifest({ events_subscribed_global: ["guild.message_create"] }),
    );
    expect(readIndex(idx).forward["guild.message_create"]).toEqual([1, 2]);

    // p1 unsubscribes via empty manifest
    applyForPlugin(idx, 1, manifest({ events_subscribed_global: [] }));
    expect(readIndex(idx).forward["guild.message_create"]).toEqual([2]);
    expect(readIndex(idx).perPlugin[1]).toBeUndefined();
    expect(readIndex(idx).perPlugin[2]).toEqual(["guild.message_create"]);
  });

  it("empty subscription set drops the per-plugin record entirely", () => {
    applyForPlugin(
      idx,
      1,
      manifest({ events_subscribed_global: ["guild.message_create"] }),
    );
    idx.applyPlugin(1, new Set());
    expect(readIndex(idx).forward).toEqual({});
    expect(readIndex(idx).perPlugin[1]).toBeUndefined();
  });

  it("merges per-feature events_subscribed with the global set", () => {
    applyForPlugin(
      idx,
      1,
      manifest({
        events_subscribed_global: ["guild.message_create"],
        guild_features: [
          {
            key: "f1",
            name: "f1",
            events_subscribed: ["guild.voice_state_update"],
          },
        ],
      }),
    );
    expect(readIndex(idx).perPlugin[1]).toEqual([
      "guild.message_create",
      "guild.voice_state_update",
    ]);
  });

  it("dedups duplicate event-type strings within a manifest", () => {
    const evs = collectSubscribedEvents(
      manifest({
        events_subscribed_global: [
          "guild.message_create",
          "guild.message_create",
        ],
        guild_features: [
          {
            key: "f1",
            name: "f1",
            events_subscribed: ["guild.message_create"],
          },
        ],
      }),
    );
    expect(evs.size).toBe(1);
    expect([...evs]).toEqual(["guild.message_create"]);
  });

  it("ignores empty / non-string event type entries", () => {
    const evs = collectSubscribedEvents(
      manifest({
        events_subscribed_global: ["", "guild.message_create"],
      } as unknown as Partial<PluginManifest>),
    );
    expect([...evs]).toEqual(["guild.message_create"]);
  });

  it("parseManifestJson returns null on invalid JSON without throwing", () => {
    expect(parseManifestJson("{not json")).toBeNull();
    expect(parseManifestJson("null")).toBeNull();
    expect(parseManifestJson(JSON.stringify(manifest({})))).not.toBeNull();
  });

  it("subscribers / hasSubscribers report fresh state after deletes", () => {
    applyForPlugin(
      idx,
      1,
      manifest({ events_subscribed_global: ["guild.message_create"] }),
    );
    expect(idx.size()).toBe(1);
    idx.applyPlugin(1, new Set());
    expect(idx.size()).toBe(0);
    expect(idx.hasSubscribers("guild.message_create")).toBe(false);
    expect(idx.subscribers("guild.message_create")).toEqual([]);
  });

  it("setAll fully replaces internal state (used at startup)", () => {
    applyForPlugin(
      idx,
      1,
      manifest({ events_subscribed_global: ["a"] }),
    );
    const map = new Map<string, Set<number>>([["b", new Set([2, 3])]]);
    const perPlugin = new Map<number, Set<string>>([
      [2, new Set(["b"])],
      [3, new Set(["b"])],
    ]);
    idx.setAll(map, perPlugin);
    expect(readIndex(idx).forward).toEqual({ b: [2, 3] });
    expect(readIndex(idx).perPlugin[1]).toBeUndefined();
  });
});

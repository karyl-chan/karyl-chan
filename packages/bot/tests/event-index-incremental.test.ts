/**
 * Incremental event-index updates without a full table scan.
 *
 * Tests the pure `EventIndex` + `collectEventRoutes` /
 * `collectSubscribedEvents` / `parseManifestJson` helpers in
 * plugin-event-index.ts (PM-8 route-aware shape). The bridge module
 * wires these into the DB-driven flow; the logic itself is pure and
 * verifiable without sqlite3 / sequelize loaded.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  EventIndex,
  collectEventRoutes,
  collectSubscribedEvents,
  parseManifestJson,
  type EventScope,
} from "../src/modules/plugin-system/plugin-event-index.js";
import type { PluginManifest } from "../src/modules/plugin-system/plugin-sdk-types.js";

function manifest(m: Partial<PluginManifest>): PluginManifest {
  return {
    plugin: { id: "p", name: "p", version: "0", url: "http://x" },
    ...m,
  } as PluginManifest;
}

/** Apply with every declared global subscription granted (auto-approve). */
function applyForPlugin(idx: EventIndex, id: number, m: PluginManifest): void {
  const grantedAll = new Set(
    (m.events_subscribed_global ?? []).filter(
      (e): e is string => typeof e === "string",
    ),
  );
  idx.applyPlugin(id, collectEventRoutes(m, grantedAll));
}

function readIndex(idx: EventIndex): {
  forward: Record<string, number[]>;
  perPlugin: Record<number, string[]>;
} {
  const snap = idx.snapshot();
  const forward: Record<string, number[]> = {};
  for (const [ev, inner] of snap.map)
    forward[ev] = Array.from(inner.keys()).sort();
  const perPlugin: Record<number, string[]> = {};
  for (const [id, routes] of snap.perPlugin)
    perPlugin[id] = Array.from(routes.keys()).sort();
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

  it("empty route map drops the per-plugin record entirely", () => {
    applyForPlugin(
      idx,
      1,
      manifest({ events_subscribed_global: ["guild.message_create"] }),
    );
    idx.applyPlugin(1, new Map());
    expect(readIndex(idx).forward).toEqual({});
    expect(readIndex(idx).perPlugin[1]).toBeUndefined();
  });

  it("setAll fully replaces internal state (used at startup)", () => {
    applyForPlugin(
      idx,
      1,
      manifest({ events_subscribed_global: ["guild.message_create"] }),
    );
    const fresh = new Map<number, Map<string, EventScope[]>>([
      [2, new Map([["guild.voice_state_update", ["global" as const]]])],
    ]);
    idx.setAll(fresh);
    const x = readIndex(idx);
    expect(x.forward["guild.message_create"]).toBeUndefined();
    expect(x.forward["guild.voice_state_update"]).toEqual([2]);
    expect(x.perPlugin[1]).toBeUndefined();
  });

  it("subscribers / hasSubscribers report fresh state after deletes", () => {
    applyForPlugin(
      idx,
      1,
      manifest({ events_subscribed_global: ["guild.message_create"] }),
    );
    idx.applyPlugin(1, new Map());
    expect(idx.subscribers("guild.message_create")).toEqual([]);
    expect(idx.hasSubscribers("guild.message_create")).toBe(false);
  });
});

describe("collectEventRoutes (PM-8 scopes)", () => {
  it("feature subscriptions carry their owning featureKey", () => {
    const routes = collectEventRoutes(
      manifest({
        guild_features: [
          {
            key: "f1",
            name: "f1",
            events_subscribed: ["guild.message_create"],
          },
        ],
      }),
      new Set(),
    );
    expect(routes.get("guild.message_create")).toEqual([
      { featureKey: "f1" },
    ]);
  });

  it("granted global subscriptions get a global route; ungranted get none", () => {
    const m = manifest({
      events_subscribed_global: ["dm.message_create", "guild.message_create"],
    });
    const routes = collectEventRoutes(m, new Set(["dm.message_create"]));
    expect(routes.get("dm.message_create")).toEqual(["global"]);
    expect(routes.has("guild.message_create")).toBe(false);
  });

  it("the same event type can be feature-owned AND globally granted", () => {
    const m = manifest({
      events_subscribed_global: ["guild.message_create"],
      guild_features: [
        {
          key: "f1",
          name: "f1",
          events_subscribed: ["guild.message_create"],
        },
      ],
    });
    const routes = collectEventRoutes(m, new Set(["guild.message_create"]));
    expect(routes.get("guild.message_create")).toEqual([
      { featureKey: "f1" },
      "global",
    ]);
  });

  it("multiple owning features each get a route", () => {
    const m = manifest({
      guild_features: [
        { key: "f1", name: "f1", events_subscribed: ["guild.message_create"] },
        { key: "f2", name: "f2", events_subscribed: ["guild.message_create"] },
      ],
    });
    const routes = collectEventRoutes(m, new Set());
    expect(routes.get("guild.message_create")).toEqual([
      { featureKey: "f1" },
      { featureKey: "f2" },
    ]);
  });
});

describe("collectSubscribedEvents (approval-blind declaration set)", () => {
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
});

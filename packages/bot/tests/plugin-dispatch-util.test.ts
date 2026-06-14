/**
 * parsePluginManifest — the one canonical manifest parse. It memoizes
 * per PluginRow instance (WeakMap) so the dispatch / RPC / reach paths
 * that used to each `JSON.parse(plugin.manifestJson)` now parse once per
 * row, and a malformed manifest fails closed (null) rather than throwing.
 */
import { describe, it, expect } from "vitest";
import { parsePluginManifest } from "../src/modules/plugin-system/plugin-dispatch-util.js";
import type { PluginRow } from "../src/modules/plugin-system/models/plugin.model.js";

function rowWith(manifestJson: string): PluginRow {
  return { id: 1, pluginKey: "p", manifestJson } as unknown as PluginRow;
}

describe("parsePluginManifest", () => {
  it("parses a row's manifest and returns the typed object", () => {
    const row = rowWith(
      JSON.stringify({
        plugin: { id: "p", name: "p", version: "0", url: "http://x" },
        guild_features: [{ key: "f", name: "f", enabled_by_default: true }],
      }),
    );
    const m = parsePluginManifest(row);
    expect(m?.guild_features?.[0]?.key).toBe("f");
  });

  it("fails closed (null) on unparseable JSON instead of throwing", () => {
    expect(parsePluginManifest(rowWith("{not json"))).toBeNull();
  });

  it("memoizes per row instance — the same row parses at most once", () => {
    // A getter that counts how many times manifestJson is read proves the
    // second call is served from the WeakMap, not re-parsed.
    let reads = 0;
    const row = {
      id: 2,
      pluginKey: "p",
      get manifestJson() {
        reads++;
        return JSON.stringify({
          plugin: { id: "p", name: "p", version: "0", url: "http://x" },
        });
      },
    } as unknown as PluginRow;

    const a = parsePluginManifest(row);
    const b = parsePluginManifest(row);
    expect(reads).toBe(1); // second call hit the memo, didn't re-read/parse
    expect(b).toBe(a); // same cached object identity

    // A distinct row object parses on its own.
    const other = rowWith(
      JSON.stringify({ plugin: { id: "q", name: "q", version: "0", url: "http://y" } }),
    );
    expect(parsePluginManifest(other)).not.toBe(a);
  });
});

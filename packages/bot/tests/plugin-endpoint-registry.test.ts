/**
 * PluginEndpointRegistry — multi-endpoint, TTL-bounded address tracking
 * (PR-3.1). Pure in-memory logic with an injected clock; no DB / network.
 *
 * Covers the single-replica invariant (size-1 set === current behaviour),
 * multi-replica accumulation, per-endpoint TTL expiry, graceful single-
 * replica removal, and the sweep reaper.
 */

import { describe, expect, it } from "vitest";
import { PluginEndpointRegistry } from "../src/modules/plugin-system/plugin-endpoint-registry.js";

function fakeClock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe("PluginEndpointRegistry", () => {
  it("single-replica default: one touch → one live endpoint", () => {
    const clock = fakeClock();
    const reg = new PluginEndpointRegistry({ ttlMs: 75_000, now: clock.now });
    reg.touch("radio", "http://radio:3000");
    expect(reg.endpoints("radio")).toEqual(["http://radio:3000"]);
    expect(reg.size()).toBe(1);
  });

  it("normalises trailing slashes so the same address dedupes to one", () => {
    const clock = fakeClock();
    const reg = new PluginEndpointRegistry({ ttlMs: 75_000, now: clock.now });
    reg.touch("radio", "http://radio:3000");
    reg.touch("radio", "http://radio:3000/");
    expect(reg.endpoints("radio")).toEqual(["http://radio:3000"]);
  });

  it("accumulates multiple distinct replica addresses under one key", () => {
    const clock = fakeClock();
    const reg = new PluginEndpointRegistry({ ttlMs: 75_000, now: clock.now });
    reg.touch("radio", "http://radio-a:3000");
    reg.touch("radio", "http://radio-b:3000");
    reg.touch("radio", "http://radio-c:3000");
    expect(reg.endpoints("radio")).toEqual([
      "http://radio-a:3000",
      "http://radio-b:3000",
      "http://radio-c:3000",
    ]);
  });

  it("expires an endpoint that stops heartbeating, keeps live siblings", () => {
    const clock = fakeClock();
    const reg = new PluginEndpointRegistry({ ttlMs: 75_000, now: clock.now });
    reg.touch("radio", "http://radio-a:3000");
    reg.touch("radio", "http://radio-b:3000");
    // 50s later only B beats again.
    clock.advance(50_000);
    reg.touch("radio", "http://radio-b:3000");
    // 40s further: A is now 90s stale (>75s TTL), B is 40s fresh.
    clock.advance(40_000);
    expect(reg.endpoints("radio")).toEqual(["http://radio-b:3000"]);
  });

  it("sliding a touch forward keeps an endpoint alive across the TTL", () => {
    const clock = fakeClock();
    const reg = new PluginEndpointRegistry({ ttlMs: 30_000, now: clock.now });
    reg.touch("p", "http://p:3000");
    clock.advance(20_000);
    reg.touch("p", "http://p:3000"); // re-beat
    clock.advance(20_000); // 20s since last beat < 30s TTL
    expect(reg.endpoints("p")).toEqual(["http://p:3000"]);
  });

  it("remove() drops one replica immediately (graceful single-replica shutdown)", () => {
    const clock = fakeClock();
    const reg = new PluginEndpointRegistry({ ttlMs: 75_000, now: clock.now });
    reg.touch("radio", "http://radio-a:3000");
    reg.touch("radio", "http://radio-b:3000/"); // trailing slash
    reg.remove("radio", "http://radio-b:3000"); // normalised match
    expect(reg.endpoints("radio")).toEqual(["http://radio-a:3000"]);
  });

  it("removeAll() drops the whole key", () => {
    const clock = fakeClock();
    const reg = new PluginEndpointRegistry({ ttlMs: 75_000, now: clock.now });
    reg.touch("radio", "http://radio-a:3000");
    reg.touch("radio", "http://radio-b:3000");
    reg.removeAll("radio");
    expect(reg.endpoints("radio")).toEqual([]);
    expect(reg.size()).toBe(0);
  });

  it("reap() returns keys that lost endpoints and prunes the bucket", () => {
    const clock = fakeClock();
    const reg = new PluginEndpointRegistry({ ttlMs: 30_000, now: clock.now });
    reg.touch("a", "http://a:3000");
    reg.touch("b", "http://b:3000");
    clock.advance(20_000);
    reg.touch("b", "http://b:3000"); // b stays fresh
    clock.advance(20_000); // a is 40s stale, b is 20s fresh
    const reaped = reg.reap();
    expect(reaped).toEqual(["a"]);
    expect(reg.endpoints("a")).toEqual([]);
    expect(reg.endpoints("b")).toEqual(["http://b:3000"]);
  });

  it("ignores empty/non-string urls without throwing", () => {
    const clock = fakeClock();
    const reg = new PluginEndpointRegistry({ ttlMs: 75_000, now: clock.now });
    reg.touch("p", "");
    reg.remove("p", "");
    expect(reg.endpoints("p")).toEqual([]);
  });
});

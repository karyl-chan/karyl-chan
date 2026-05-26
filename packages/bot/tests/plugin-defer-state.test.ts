/**
 * In-memory per-interaction defer-state tracker. Confirms record/read/
 * clear lifecycle + TTL expiry behavior so the mismatch routing in
 * interactions.respond stays correct.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  recordPluginDeferEphemeral,
  readPluginDeferEphemeral,
  clearPluginDeferEphemeral,
  _resetPluginDeferStateForTests,
} from "../src/modules/plugin-system/plugin-defer-state.js";

beforeEach(() => {
  _resetPluginDeferStateForTests();
  vi.useRealTimers();
});

describe("plugin-defer-state", () => {
  it("returns null when no record exists", () => {
    expect(readPluginDeferEphemeral("nope")).toBeNull();
  });

  it("round-trips ephemeral=true", () => {
    recordPluginDeferEphemeral("t-a", true);
    expect(readPluginDeferEphemeral("t-a")).toBe(true);
  });

  it("round-trips ephemeral=false", () => {
    recordPluginDeferEphemeral("t-b", false);
    expect(readPluginDeferEphemeral("t-b")).toBe(false);
  });

  it("subsequent record overwrites (last writer wins)", () => {
    recordPluginDeferEphemeral("t-c", true);
    recordPluginDeferEphemeral("t-c", false);
    expect(readPluginDeferEphemeral("t-c")).toBe(false);
  });

  it("clearPluginDeferEphemeral drops the record", () => {
    recordPluginDeferEphemeral("t-d", true);
    clearPluginDeferEphemeral("t-d");
    expect(readPluginDeferEphemeral("t-d")).toBeNull();
  });

  it("read returns null and lazily evicts after TTL (>16 min)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    recordPluginDeferEphemeral("t-e", true);
    expect(readPluginDeferEphemeral("t-e")).toBe(true);
    // Past the 16-min TTL — read should evict + return null.
    vi.setSystemTime(new Date("2026-01-01T00:17:00Z"));
    expect(readPluginDeferEphemeral("t-e")).toBeNull();
    // A subsequent record on the same token works (the evicted entry
    // doesn't leak and prevent re-recording).
    recordPluginDeferEphemeral("t-e", false);
    expect(readPluginDeferEphemeral("t-e")).toBe(false);
  });
});

/**
 * In-memory per-interaction defer-state tracker. Confirms kind+ephemeral
 * round-trip + TTL expiry behavior so the mismatch routing in
 * interactions.respond stays correct, and (critically) the kind='update'
 * path for component clicks prevents the respond endpoint from DELETing
 * the user's own message.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  recordPluginDeferReply,
  recordPluginDeferUpdate,
  readPluginDeferState,
  clearPluginDeferState,
  _resetPluginDeferStateForTests,
} from "../src/modules/plugin-system/plugin-defer-state.js";

beforeEach(() => {
  _resetPluginDeferStateForTests();
  vi.useRealTimers();
});

describe("plugin-defer-state", () => {
  it("returns null when no record exists", () => {
    expect(readPluginDeferState("nope")).toBeNull();
  });

  it("recordPluginDeferReply round-trips kind + ephemeral=true", () => {
    recordPluginDeferReply("t-a", true);
    expect(readPluginDeferState("t-a")).toEqual({
      kind: "reply",
      ephemeral: true,
    });
  });

  it("recordPluginDeferReply round-trips kind + ephemeral=false", () => {
    recordPluginDeferReply("t-b", false);
    expect(readPluginDeferState("t-b")).toEqual({
      kind: "reply",
      ephemeral: false,
    });
  });

  it("recordPluginDeferUpdate stores kind='update' (component path)", () => {
    recordPluginDeferUpdate("t-comp");
    expect(readPluginDeferState("t-comp")).toEqual({
      kind: "update",
      ephemeral: false,
    });
  });

  it("subsequent record overwrites (last writer wins)", () => {
    recordPluginDeferReply("t-c", true);
    recordPluginDeferUpdate("t-c");
    expect(readPluginDeferState("t-c")).toMatchObject({ kind: "update" });
  });

  it("clearPluginDeferState drops the record", () => {
    recordPluginDeferReply("t-d", true);
    clearPluginDeferState("t-d");
    expect(readPluginDeferState("t-d")).toBeNull();
  });

  it("read returns null and lazily evicts after TTL (>16 min)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    recordPluginDeferReply("t-e", true);
    expect(readPluginDeferState("t-e")).toMatchObject({ ephemeral: true });
    // Past the 16-min TTL — read should evict + return null.
    vi.setSystemTime(new Date("2026-01-01T00:17:00Z"));
    expect(readPluginDeferState("t-e")).toBeNull();
    // A subsequent record on the same token works (the evicted entry
    // doesn't leak and prevent re-recording).
    recordPluginDeferReply("t-e", false);
    expect(readPluginDeferState("t-e")).toMatchObject({ ephemeral: false });
  });
});

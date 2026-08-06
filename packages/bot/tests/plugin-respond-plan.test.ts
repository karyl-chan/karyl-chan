/**
 * planPluginRespond seam tests (#56) — the defer → respond transition
 * table, now owned by plugin-defer-state alongside the state it reads.
 *
 * Why at the seam: no route suite fakes Discord REST for
 * `interactions.respond` (the schema suite deliberately pins parsing
 * only), so the four-case defer/want table, the kind='update' guard
 * (never delete the user's own message), the null-state fallback, and
 * the historical any-type truthiness of `ephemeral` are not reachable
 * through HTTP tests today. This enumerates them against the real
 * in-memory state store — nothing is faked.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  recordPluginDeferReply,
  recordPluginDeferUpdate,
  readPluginDeferState,
  planPluginRespond,
  _resetPluginDeferStateForTests,
} from "../src/modules/plugin-system/plugin-defer-state.js";

beforeEach(() => {
  _resetPluginDeferStateForTests();
});

describe("planPluginRespond — kind='reply' four-case table", () => {
  it("defer=E want=E patches @original", () => {
    recordPluginDeferReply("t", true);
    expect(planPluginRespond("t", true)).toEqual({ action: "patch-original" });
  });

  it("defer=P want=P patches @original", () => {
    recordPluginDeferReply("t", false);
    expect(planPluginRespond("t", false)).toEqual({ action: "patch-original" });
  });

  it("defer=E want=P follows up publicly then deletes @original", () => {
    recordPluginDeferReply("t", true);
    expect(planPluginRespond("t", false)).toEqual({
      action: "followup-then-delete-original",
      ephemeral: false,
    });
  });

  it("defer=P want=E follows up ephemerally then deletes @original", () => {
    recordPluginDeferReply("t", false);
    expect(planPluginRespond("t", true)).toEqual({
      action: "followup-then-delete-original",
      ephemeral: true,
    });
  });

  it("an absent ephemeral field means 'whatever the defer was' — never a mismatch", () => {
    recordPluginDeferReply("t1", true);
    expect(planPluginRespond("t1", undefined)).toEqual({
      action: "patch-original",
    });
    recordPluginDeferReply("t2", false);
    expect(planPluginRespond("t2", undefined)).toEqual({
      action: "patch-original",
    });
  });

  it("keeps the historical truthiness rule: any present non-false value means ephemeral", () => {
    recordPluginDeferReply("t", false);
    // null, 0, "" — all present-and-not-false, all mean "ephemeral".
    expect(planPluginRespond("t", null)).toEqual({
      action: "followup-then-delete-original",
      ephemeral: true,
    });
    expect(planPluginRespond("t", 0)).toEqual({
      action: "followup-then-delete-original",
      ephemeral: true,
    });
    expect(planPluginRespond("t", "")).toEqual({
      action: "followup-then-delete-original",
      ephemeral: true,
    });
  });
});

describe("planPluginRespond — kind='update' (component clicks)", () => {
  it("always patches @original, whatever ephemerality is requested", () => {
    // @original is the user's own message hosting the component — the
    // followup-then-delete path must never run for updates.
    recordPluginDeferUpdate("t");
    expect(planPluginRespond("t", true)).toEqual({ action: "patch-original" });
    expect(planPluginRespond("t", false)).toEqual({ action: "patch-original" });
    expect(planPluginRespond("t", undefined)).toEqual({
      action: "patch-original",
    });
  });
});

describe("planPluginRespond — null state and read-only contract", () => {
  it("falls back to {kind:'reply', ephemeral:true} when no state exists", () => {
    // The dispatcher's default: want=E matches, want=P mismatches.
    expect(planPluginRespond("gone", undefined)).toEqual({
      action: "patch-original",
    });
    expect(planPluginRespond("gone", false)).toEqual({
      action: "followup-then-delete-original",
      ephemeral: false,
    });
  });

  it("does not consume the state — the route clears only after Discord accepts", () => {
    recordPluginDeferReply("t", true);
    planPluginRespond("t", false);
    expect(readPluginDeferState("t")).toEqual({
      kind: "reply",
      ephemeral: true,
    });
  });
});

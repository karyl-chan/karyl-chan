/**
 * S2 (#133)：註冊目標的純函式（command-target.ts）與名冊 stale 判斷
 * （isOwnedCommandDesired）。表格驅動，預期值逐列手寫。
 */

import { vi, describe, it, expect } from "vitest";

vi.hoisted(() => {
  process.env.SQLITE_DB_PATH = ":memory:";
});

import {
  expandTarget,
  targetCovers,
  targetMatchesInvocation,
  targetsConflict,
  type CommandTarget,
  type ConcreteTarget,
} from "../src/modules/command-system/command-target.js";
import { isOwnedCommandDesired } from "../src/modules/command-system/reconcile.service.js";

describe("expandTarget", () => {
  it.each<[CommandTarget, string[], ConcreteTarget[]]>([
    ["global", ["g1", "g2"], ["global"]],
    ["guild:g1", ["g1", "g2"], ["guild:g1"]],
    // 指定的伺服器不在 cache 也原樣回傳（能不能操作由 reconciler 判斷）
    ["guild:gx", ["g1"], ["guild:gx"]],
    ["all_guilds", ["g1", "g2"], ["guild:g1", "guild:g2"]],
    ["all_guilds", [], []],
  ])("%s over [%s] → %j", (target, guilds, expected) => {
    expect(expandTarget(target, guilds)).toEqual(expected);
  });
});

describe("targetCovers", () => {
  it.each<[CommandTarget, ConcreteTarget, boolean]>([
    ["global", "global", true],
    ["global", "guild:g1", false],
    ["guild:g1", "guild:g1", true],
    ["guild:g1", "guild:g2", false],
    ["guild:g1", "global", false],
    ["all_guilds", "guild:g1", true],
    ["all_guilds", "global", false],
  ])("%s covers %s → %s", (target, concrete, expected) => {
    expect(targetCovers(target, concrete)).toBe(expected);
  });
});

describe("targetMatchesInvocation", () => {
  it.each<[CommandTarget, string | null, boolean]>([
    ["global", null, true],
    ["global", "g1", false],
    ["guild:g1", "g1", true],
    ["guild:g1", "g2", false],
    ["guild:g1", null, false],
    ["all_guilds", "g1", true],
    ["all_guilds", null, false],
  ])("%s claims commandGuildId=%s → %s", (target, commandGuildId, expected) => {
    expect(targetMatchesInvocation(target, commandGuildId)).toBe(expected);
  });
});

describe("targetsConflict", () => {
  it.each<[CommandTarget, CommandTarget, boolean]>([
    ["global", "global", true],
    ["global", "guild:g1", true],
    ["global", "all_guilds", true],
    ["guild:g1", "guild:g1", true],
    ["guild:g1", "guild:g2", false],
    ["guild:g1", "all_guilds", true],
    ["all_guilds", "all_guilds", true],
  ])("%s vs %s → %s", (a, b, expected) => {
    expect(targetsConflict(a, b)).toBe(expected);
    expect(targetsConflict(b, a)).toBe(expected);
  });
});

describe("isOwnedCommandDesired", () => {
  const desired: Array<{ name: string; target: CommandTarget }> = [
    { name: "ping", target: "guild:g1" },
    { name: "every", target: "all_guilds" },
    { name: "top", target: "global" },
  ];

  it.each<[string, ConcreteTarget, boolean]>([
    ["ping", "guild:g1", true],
    ["ping", "guild:g2", false], // 搬走的伺服器 → stale
    ["ping", "global", false],
    ["every", "guild:g7", true],
    ["every", "global", false],
    ["top", "global", true],
    ["top", "guild:g1", false],
    ["gone", "global", false],
  ])("owned %s @ %s → %s", (name, target, expected) => {
    expect(isOwnedCommandDesired({ name, target }, desired)).toBe(expected);
  });
});

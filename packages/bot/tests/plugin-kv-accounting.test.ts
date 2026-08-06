/**
 * Guild-KV Accounting seam tests (#56).
 *
 * The storage routes stay covered end to end by the schema suites and
 * plugin-kv.test.ts; these tests exist only for arithmetic those route
 * suites cannot pin cheaply or at all:
 *
 *  - the exact quota boundary (`projected > quota` — writing at exactly
 *    the quota is legal, one byte over is not), which over HTTP would
 *    need multi-KiB payloads tuned to the default quota;
 *  - the overwrite subtraction (an existing key's bytes come out of the
 *    projection before the incoming bytes go in);
 *  - bytes-not-characters (multibyte UTF-8 counts serialised bytes);
 *  - the refusal ordering (per-row hard cap fires before, and instead
 *    of, the guild-quota projection);
 *  - the deliberate non-enforcement on increments (a counter may push
 *    the guild past quota; it is reported, never refused) — invisible
 *    from route tests unless one engineers a full guild first.
 *
 * Driven against the real in-memory sqlite KV model, faking only the
 * plugin row lookup that quota derivation reads the manifest from.
 */
import { vi, describe, it, expect, beforeAll, beforeEach } from "vitest";

vi.hoisted(() => {
  process.env.SQLITE_DB_PATH = ":memory:";
});

vi.mock("../src/modules/plugin-system/models/plugin.model.js", () => ({
  findPluginById: vi.fn(),
}));

import { sequelize } from "../src/db.js";
import { findPluginById } from "../src/modules/plugin-system/models/plugin.model.js";
import {
  PluginKv,
  deleteKv,
  getKv,
} from "../src/modules/plugin-system/models/plugin-kv.model.js";
import { KV_VALUE_MAX_BYTES } from "../src/modules/plugin-system/plugin-kv-quota.js";
import {
  guildKvUsage,
  incrementGuildKv,
  writeGuildKv,
} from "../src/modules/plugin-system/plugin-kv-accounting.js";

const PID = 1;
const GID = "guild-q";

// Manifest declares 1 KiB so the boundary sits at 1024 bytes — small
// enough to spell values out literally. (quotaForGuildKv: declaredKb *
// 1024, clamped to KV_VALUE_MAX_BYTES * 16; 1 KiB is far below the
// clamp.) parsePluginManifest memoises per row object via a WeakMap, so
// hand back one stable instance.
const QUOTA = 1024;
const pluginRow = {
  id: PID,
  pluginKey: "quota-plugin",
  enabled: true,
  status: "active",
  manifestJson: JSON.stringify({ storage: { guildKvQuotaKb: 1 } }),
};

beforeAll(async () => {
  await sequelize.sync({ force: true });
});

beforeEach(async () => {
  await PluginKv.destroy({ where: {} });
  vi.mocked(findPluginById).mockResolvedValue(pluginRow as never);
});

describe("writeGuildKv quota boundary", () => {
  it("accepts a write of exactly the quota (projected === quota passes)", async () => {
    const res = await writeGuildKv(PID, GID, "big", "x".repeat(QUOTA));
    expect(res).toEqual({
      ok: true,
      bytes: QUOTA,
      total_bytes: QUOTA,
      quota_bytes: QUOTA,
    });
  });

  it("refuses one byte over quota with the historical 413 text", async () => {
    await writeGuildKv(PID, GID, "big", "x".repeat(QUOTA));
    const res = await writeGuildKv(PID, GID, "extra", "y");
    expect(res).toEqual({
      ok: false,
      error: `would exceed plugin guild_kv quota (${QUOTA + 1}B / ${QUOTA}B)`,
    });
    // Refusal must not have written anything.
    expect(await getKv(PID, GID, "extra")).toBeNull();
  });

  it("subtracts the overwritten key's bytes from the projection", async () => {
    await writeGuildKv(PID, GID, "big", "x".repeat(QUOTA));
    // Same key, same size: projected = 1024 - 1024 + 1024 = quota. Legal.
    const res = await writeGuildKv(PID, GID, "big", "z".repeat(QUOTA));
    expect(res).toEqual({
      ok: true,
      bytes: QUOTA,
      total_bytes: QUOTA,
      quota_bytes: QUOTA,
    });
  });

  it("accepts a zero-byte value even with the guild at exactly quota", async () => {
    await writeGuildKv(PID, GID, "big", "x".repeat(QUOTA));
    const res = await writeGuildKv(PID, GID, "empty", "");
    expect(res).toEqual({
      ok: true,
      bytes: 0,
      total_bytes: QUOTA,
      quota_bytes: QUOTA,
    });
  });

  it("counts serialised UTF-8 bytes, not characters", async () => {
    // 513 two-byte characters = 1026 bytes: over a 1024-byte quota even
    // though the string is barely half the quota in characters.
    const res = await writeGuildKv(PID, GID, "wide", "é".repeat(513));
    expect(res).toEqual({
      ok: false,
      error: `would exceed plugin guild_kv quota (1026B / ${QUOTA}B)`,
    });
  });

  it("a delete frees quota for the next write", async () => {
    await writeGuildKv(PID, GID, "big", "x".repeat(QUOTA));
    expect(await deleteKv(PID, GID, "big")).toBe(true);
    const res = await writeGuildKv(PID, GID, "after", "fresh");
    expect(res).toEqual({
      ok: true,
      bytes: 5,
      total_bytes: 5,
      quota_bytes: QUOTA,
    });
  });

  it("the per-row hard cap fires before (and instead of) the quota projection", async () => {
    const res = await writeGuildKv(PID, GID, "huge", "x".repeat(KV_VALUE_MAX_BYTES + 1));
    expect(res).toEqual({
      ok: false,
      error: `value exceeds per-row hard cap (${KV_VALUE_MAX_BYTES}B)`,
    });
  });
});

describe("incrementGuildKv", () => {
  it("reports post-increment usage against the quota", async () => {
    const res = await incrementGuildKv(PID, GID, "counter", 41);
    expect(res).toEqual({
      value: 41,
      bytes: 2, // "41"
      total_bytes: 2,
      quota_bytes: QUOTA,
    });
  });

  it("does not enforce the guild quota (reported, never refused)", async () => {
    await writeGuildKv(PID, GID, "big", "x".repeat(QUOTA));
    const res = await incrementGuildKv(PID, GID, "counter", 7);
    expect(res).toEqual({
      value: 7,
      bytes: 1,
      total_bytes: QUOTA + 1, // past quota, and that is the pinned behaviour
      quota_bytes: QUOTA,
    });
  });

  it("propagates the model's non-numeric error untouched (route maps it to 422)", async () => {
    await writeGuildKv(PID, GID, "counter", "not-a-number");
    await expect(incrementGuildKv(PID, GID, "counter", 1)).rejects.toThrow(
      /not a finite number/,
    );
  });
});

describe("guildKvUsage", () => {
  it("reports zero usage against the derived quota for an empty guild", async () => {
    expect(await guildKvUsage(PID, GID)).toEqual({
      used_bytes: 0,
      quota_bytes: QUOTA,
    });
  });

  it("sums stored bytes for the guild", async () => {
    await writeGuildKv(PID, GID, "a", "hello");
    await writeGuildKv(PID, GID, "b", "worlds");
    await writeGuildKv(PID, "other-guild", "a", "ignored");
    expect(await guildKvUsage(PID, GID)).toEqual({
      used_bytes: 11,
      quota_bytes: QUOTA,
    });
  });
});

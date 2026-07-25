/**
 * PM-8 — FeatureReachResolver: cached per-feature-key 3-tier resolution.
 * DB-backed (sqlite :memory:) so the row/default precedence is tested
 * against the real model queries, with an injectable clock for TTL.
 */
import { vi, describe, it, expect, beforeAll, beforeEach } from "vitest";

vi.hoisted(() => {
  process.env.SQLITE_DB_PATH = ":memory:";
});

import { sequelize } from "../src/db.js";
import {
  PluginGuildFeature,
  upsertFeatureRow,
} from "../src/modules/feature-toggle/models/plugin-guild-feature.model.js";
import {
  PluginFeatureDefault,
  upsertFeatureDefault,
} from "../src/modules/feature-toggle/models/plugin-feature-default.model.js";
import {
  FeatureReachResolver,
  featureReachResolver,
  resolvePrecedenceTiers,
} from "../src/modules/feature-toggle/feature-reach-resolver.js";
import { emitPluginChange } from "../src/modules/plugin-system/plugin-changes.js";
import type { PluginManifest } from "../src/modules/plugin-system/plugin-sdk-types.js";

const PLUGIN_ID = 7;
const GUILD = "g1";

function manifestWith(
  features: { key: string; enabled_by_default?: boolean }[],
): PluginManifest {
  return {
    plugin: { id: "p", name: "p", version: "0", url: "http://x" },
    guild_features: features.map((f) => ({ name: f.key, ...f })),
  } as unknown as PluginManifest;
}

beforeAll(async () => {
  await sequelize.sync({ force: true });
});

beforeEach(async () => {
  await PluginGuildFeature.destroy({ where: {} });
  await PluginFeatureDefault.destroy({ where: {} });
});

describe("FeatureReachResolver — 3-tier precedence", () => {
  it("explicit row beats operator default beats manifest default", async () => {
    const r = new FeatureReachResolver();
    const m = manifestWith([{ key: "f", enabled_by_default: true }]);
    await upsertFeatureDefault(PLUGIN_ID, "f", true);
    await upsertFeatureRow({
      pluginId: PLUGIN_ID,
      guildId: GUILD,
      featureKey: "f",
      enabled: false,
    });
    expect(await r.isFeatureEnabledInGuild(PLUGIN_ID, GUILD, "f", m)).toBe(
      false,
    );
  });

  it("operator default applies when no row exists", async () => {
    const r = new FeatureReachResolver();
    const m = manifestWith([{ key: "f", enabled_by_default: false }]);
    await upsertFeatureDefault(PLUGIN_ID, "f", true);
    expect(await r.isFeatureEnabledInGuild(PLUGIN_ID, GUILD, "f", m)).toBe(
      true,
    );
  });

  it("manifest default is the final fallback; unknown key is false", async () => {
    const r = new FeatureReachResolver();
    const m = manifestWith([{ key: "f", enabled_by_default: true }]);
    expect(await r.isFeatureEnabledInGuild(PLUGIN_ID, GUILD, "f", m)).toBe(
      true,
    );
    expect(
      await r.isFeatureEnabledInGuild(PLUGIN_ID, GUILD, "nope", m),
    ).toBe(false);
  });

  it("hasAnyFeatureEnabledInGuild short-circuits and treats featureless as pass", async () => {
    const r = new FeatureReachResolver();
    const featureless = manifestWith([]);
    expect(
      await r.hasAnyFeatureEnabledInGuild(PLUGIN_ID, GUILD, featureless),
    ).toBe(true);
    const m = manifestWith([
      { key: "off", enabled_by_default: false },
      { key: "on", enabled_by_default: true },
    ]);
    expect(await r.hasAnyFeatureEnabledInGuild(PLUGIN_ID, GUILD, m)).toBe(
      true,
    );
    const allOff = manifestWith([{ key: "off", enabled_by_default: false }]);
    expect(
      await r.hasAnyFeatureEnabledInGuild(PLUGIN_ID, GUILD, allOff),
    ).toBe(false);
  });

  // Folded from feature-resolve.test.ts (#27): the component/modal
  // dispatch gate resolves through the full Precedence Tiers — the
  // original regression was a gate that only saw explicit enabled rows
  // and bounced clicks on enabled-by-default features with no row yet.
  it("hasAnyFeatureEnabledInGuild applies all three Precedence Tiers", async () => {
    const r = new FeatureReachResolver();
    const m = manifestWith([{ key: "f", enabled_by_default: true }]);
    // Guild Override (disable) beats both defaults…
    await upsertFeatureDefault(PLUGIN_ID, "f", true);
    await upsertFeatureRow({
      pluginId: PLUGIN_ID,
      guildId: GUILD,
      featureKey: "f",
      enabled: false,
    });
    expect(await r.hasAnyFeatureEnabledInGuild(PLUGIN_ID, GUILD, m)).toBe(
      false,
    );
    // …and an Operator Default beats the Manifest Default where no row
    // exists.
    const off = manifestWith([{ key: "g", enabled_by_default: false }]);
    await upsertFeatureDefault(PLUGIN_ID, "g", true);
    expect(await r.hasAnyFeatureEnabledInGuild(PLUGIN_ID, "g2", off)).toBe(
      true,
    );
  });
});

describe("FeatureReachResolver — cache + invalidation", () => {
  it("serves from cache within the TTL and expires after it", async () => {
    let now = 1_000;
    const r = new FeatureReachResolver({ ttlMs: 30_000, now: () => now });
    const m = manifestWith([{ key: "f", enabled_by_default: false }]);
    expect(await r.isFeatureEnabledInGuild(PLUGIN_ID, GUILD, "f", m)).toBe(
      false,
    );
    // Flip the DB underneath; the cached value must hold inside the TTL…
    await upsertFeatureRow({
      pluginId: PLUGIN_ID,
      guildId: GUILD,
      featureKey: "f",
      enabled: true,
    });
    expect(await r.isFeatureEnabledInGuild(PLUGIN_ID, GUILD, "f", m)).toBe(
      false,
    );
    // …and refresh after it.
    now += 30_001;
    expect(await r.isFeatureEnabledInGuild(PLUGIN_ID, GUILD, "f", m)).toBe(
      true,
    );
  });

  it("invalidateGuild drops exactly that guild's entries", async () => {
    const r = new FeatureReachResolver();
    const m = manifestWith([{ key: "f", enabled_by_default: false }]);
    await r.isFeatureEnabledInGuild(PLUGIN_ID, GUILD, "f", m);
    await r.isFeatureEnabledInGuild(PLUGIN_ID, "g2", "f", m);
    expect(r.size()).toBe(2);
    r.invalidateGuild(PLUGIN_ID, GUILD);
    expect(r.size()).toBe(1);
    // The dropped guild now re-reads fresh state.
    await upsertFeatureRow({
      pluginId: PLUGIN_ID,
      guildId: GUILD,
      featureKey: "f",
      enabled: true,
    });
    expect(await r.isFeatureEnabledInGuild(PLUGIN_ID, GUILD, "f", m)).toBe(
      true,
    );
  });

  it("invalidatePlugin drops all of a plugin's entries without touching others", async () => {
    const r = new FeatureReachResolver();
    const m = manifestWith([{ key: "f", enabled_by_default: true }]);
    await r.isFeatureEnabledInGuild(7, GUILD, "f", m);
    await r.isFeatureEnabledInGuild(77, GUILD, "f", m);
    expect(r.size()).toBe(2);
    r.invalidatePlugin(7);
    // Nested-by-plugin deletion must not catch plugin 77.
    expect(r.size()).toBe(1);
  });

});

describe("resolvePrecedenceTiers — the one precedence rule (#27)", () => {
  it("guild override beats operator default beats manifest default beats false", () => {
    expect(resolvePrecedenceTiers(false, true, true)).toBe(false);
    expect(resolvePrecedenceTiers(true, false, false)).toBe(true);
    expect(resolvePrecedenceTiers(undefined, false, true)).toBe(false);
    expect(resolvePrecedenceTiers(undefined, true, false)).toBe(true);
    expect(resolvePrecedenceTiers(undefined, undefined, true)).toBe(true);
    expect(resolvePrecedenceTiers(undefined, undefined, undefined)).toBe(false);
  });
});

describe("FeatureReachResolver — resolveGuildFeatures (fresh admin read, #27)", () => {
  it("reports every tier per feature, including the row for override reads", async () => {
    const r = new FeatureReachResolver();
    const m = manifestWith([
      { key: "ov", enabled_by_default: true },
      { key: "op", enabled_by_default: false },
      { key: "mf", enabled_by_default: true },
    ]);
    await upsertFeatureRow({
      pluginId: PLUGIN_ID,
      guildId: GUILD,
      featureKey: "ov",
      enabled: false,
    });
    await upsertFeatureDefault(PLUGIN_ID, "op", true);
    const resolved = await r.resolveGuildFeatures(PLUGIN_ID, GUILD, m);
    expect(resolved.get("ov")).toMatchObject({
      enabled: false,
      overridden: true,
      defaultEnabled: true,
      operatorDefault: null,
      manifestDefault: true,
    });
    expect(resolved.get("ov")?.row?.featureKey).toBe("ov");
    expect(resolved.get("op")).toMatchObject({
      enabled: true,
      overridden: false,
      defaultEnabled: true,
      operatorDefault: true,
      manifestDefault: false,
      row: null,
    });
    expect(resolved.get("mf")).toMatchObject({
      enabled: true,
      overridden: false,
      defaultEnabled: true,
      operatorDefault: null,
      manifestDefault: true,
      row: null,
    });
  });

  it("is fresh — a write is visible immediately even with a warm cache", async () => {
    const r = new FeatureReachResolver();
    const m = manifestWith([{ key: "f", enabled_by_default: false }]);
    // Warm the TTL cache with the pre-write state…
    expect(await r.isFeatureEnabledInGuild(PLUGIN_ID, GUILD, "f", m)).toBe(
      false,
    );
    await upsertFeatureRow({
      pluginId: PLUGIN_ID,
      guildId: GUILD,
      featureKey: "f",
      enabled: true,
    });
    // …the admin read bypasses it.
    const resolved = await r.resolveGuildFeatures(PLUGIN_ID, GUILD, m);
    expect(resolved.get("f")?.enabled).toBe(true);
  });
});

describe("FeatureReachResolver — enabledGuildIds (fresh batch read, #27)", () => {
  it("keeps guilds where any feature is effectively enabled, across all tiers", async () => {
    const r = new FeatureReachResolver();
    const m = manifestWith([
      { key: "a", enabled_by_default: false },
      { key: "b", enabled_by_default: false },
    ]);
    // gRow: explicit row enables `a`. gOff: explicit rows disable both.
    await upsertFeatureRow({
      pluginId: PLUGIN_ID,
      guildId: "gRow",
      featureKey: "a",
      enabled: true,
    });
    for (const key of ["a", "b"]) {
      await upsertFeatureRow({
        pluginId: PLUGIN_ID,
        guildId: "gOff",
        featureKey: key,
        enabled: false,
      });
    }
    // No rows anywhere else: gDefault follows the manifest (all-false).
    expect(
      await r.enabledGuildIds(PLUGIN_ID, ["gRow", "gOff", "gDefault"], m),
    ).toEqual(["gRow"]);
    // An operator default flips every guild without a covering row.
    await upsertFeatureDefault(PLUGIN_ID, "b", true);
    expect(
      await r.enabledGuildIds(PLUGIN_ID, ["gRow", "gOff", "gDefault"], m),
    ).toEqual(["gRow", "gDefault"]);
  });

  it("a featureless plugin passes every guild through (always-on contract)", async () => {
    const r = new FeatureReachResolver();
    expect(
      await r.enabledGuildIds(PLUGIN_ID, ["g1", "g2"], manifestWith([])),
    ).toEqual(["g1", "g2"]);
  });
});

describe("FeatureReachResolver — Plugin Change subscription (#27)", () => {
  // The singleton subscribes to Plugin Change notifications; mutation
  // owners emit instead of calling the invalidate methods directly.
  beforeEach(() => {
    featureReachResolver.clear();
  });

  it("a one-guild emit drops exactly that (plugin, guild) entry", async () => {
    const m = manifestWith([{ key: "f", enabled_by_default: true }]);
    await featureReachResolver.isFeatureEnabledInGuild(PLUGIN_ID, GUILD, "f", m);
    await featureReachResolver.isFeatureEnabledInGuild(PLUGIN_ID, "g2", "f", m);
    expect(featureReachResolver.size()).toBe(2);
    emitPluginChange({ pluginId: PLUGIN_ID, guildId: GUILD });
    expect(featureReachResolver.size()).toBe(1);
  });

  it("a plugin-wide emit (with or without a row) drops all of that plugin's entries", async () => {
    const m = manifestWith([{ key: "f", enabled_by_default: true }]);
    await featureReachResolver.isFeatureEnabledInGuild(PLUGIN_ID, GUILD, "f", m);
    await featureReachResolver.isFeatureEnabledInGuild(99, GUILD, "f", m);
    expect(featureReachResolver.size()).toBe(2);
    emitPluginChange({ pluginId: PLUGIN_ID });
    expect(featureReachResolver.size()).toBe(1);
    emitPluginChange({ pluginId: 99, row: null });
    expect(featureReachResolver.size()).toBe(0);
  });
});

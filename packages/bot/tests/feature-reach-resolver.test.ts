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
import { FeatureReachResolver } from "../src/modules/feature-toggle/feature-reach-resolver.js";
import type { PluginManifest } from "../src/modules/plugin-system/plugin-sdk-types.js";

const PLUGIN_ID = 7;
const GUILD = "g1";

function manifestWith(
  features: { key: string; enabled_by_default?: boolean }[],
): PluginManifest {
  return {
    plugin: { id: "p", name: "p", version: "0", url: "http://x" },
    guild_features: features.map((f) => ({ key: f.key, name: f.key, ...f })),
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
    // Prefix deletion must not catch plugin 77.
    expect(r.size()).toBe(1);
  });
});

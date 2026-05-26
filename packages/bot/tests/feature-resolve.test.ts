/**
 * Regression: plugin-component-dispatch / plugin-modal-dispatch used
 * findEnabledFeaturesByPluginGuild which only returns explicit
 * enabled=true rows. A plugin with manifest enabled_by_default=true and
 * no per-guild row was incorrectly classified as disabled, so every
 * button/modal interaction was bounced with "此功能在本伺服器已停用"
 * even though the slash commands worked and the admin UI showed the
 * plugin as enabled.
 *
 * isPluginEffectivelyEnabledInGuild applies the 3-tier resolution
 * (row → operator default → manifest enabled_by_default).
 */

import { vi, describe, it, expect, beforeAll, beforeEach } from "vitest";

vi.hoisted(() => {
  process.env.SQLITE_DB_PATH = ":memory:";
});

import { sequelize } from "../src/db.js";
import { PluginGuildFeature } from "../src/modules/feature-toggle/models/plugin-guild-feature.model.js";
import { PluginFeatureDefault } from "../src/modules/feature-toggle/models/plugin-feature-default.model.js";
import { isPluginEffectivelyEnabledInGuild } from "../src/modules/feature-toggle/feature-resolve.js";
import type { PluginManifest } from "../src/modules/plugin-system/plugin-sdk-types.js";

const PLUGIN_ID = 100;
const GUILD = "g1";

function manifestWith(
  features: { key: string; enabled_by_default?: boolean }[],
): PluginManifest {
  return {
    name: "test",
    version: "1.0.0",
    description: "",
    plugin_key: "test",
    endpoints: {},
    guild_features: features.map((f) => ({
      key: f.key,
      name: f.key,
      enabled_by_default: f.enabled_by_default,
    })),
  } as unknown as PluginManifest;
}

beforeAll(async () => {
  await sequelize.sync({ force: true });
});

beforeEach(async () => {
  await PluginGuildFeature.destroy({ where: {} });
  await PluginFeatureDefault.destroy({ where: {} });
});

describe("isPluginEffectivelyEnabledInGuild", () => {
  it("returns true when manifest defaults a feature to enabled and no row exists (the bug)", async () => {
    const manifest = manifestWith([{ key: "f", enabled_by_default: true }]);
    expect(
      await isPluginEffectivelyEnabledInGuild(PLUGIN_ID, GUILD, manifest),
    ).toBe(true);
  });

  it("returns false when manifest defaults a feature to disabled and no row exists", async () => {
    const manifest = manifestWith([{ key: "f", enabled_by_default: false }]);
    expect(
      await isPluginEffectivelyEnabledInGuild(PLUGIN_ID, GUILD, manifest),
    ).toBe(false);
  });

  it("per-guild row OVERRIDES operator default and manifest default", async () => {
    const manifest = manifestWith([{ key: "f", enabled_by_default: true }]);
    await PluginFeatureDefault.create({
      pluginId: PLUGIN_ID,
      featureKey: "f",
      enabled: true,
    });
    await PluginGuildFeature.create({
      pluginId: PLUGIN_ID,
      guildId: GUILD,
      featureKey: "f",
      enabled: false, // explicit per-guild disable beats both defaults
      configJson: "{}",
      metricsJson: "{}",
    });
    expect(
      await isPluginEffectivelyEnabledInGuild(PLUGIN_ID, GUILD, manifest),
    ).toBe(false);
  });

  it("operator default OVERRIDES manifest default when no per-guild row exists", async () => {
    const manifest = manifestWith([{ key: "f", enabled_by_default: false }]);
    await PluginFeatureDefault.create({
      pluginId: PLUGIN_ID,
      featureKey: "f",
      enabled: true,
    });
    expect(
      await isPluginEffectivelyEnabledInGuild(PLUGIN_ID, GUILD, manifest),
    ).toBe(true);
  });

  it("returns true if ANY feature is effectively enabled", async () => {
    const manifest = manifestWith([
      { key: "off", enabled_by_default: false },
      { key: "on", enabled_by_default: true },
    ]);
    expect(
      await isPluginEffectivelyEnabledInGuild(PLUGIN_ID, GUILD, manifest),
    ).toBe(true);
  });

  it("returns true when the manifest has no guild_features at all (plugin-level gating only)", async () => {
    const manifest = manifestWith([]);
    expect(
      await isPluginEffectivelyEnabledInGuild(PLUGIN_ID, GUILD, manifest),
    ).toBe(true);
  });
});

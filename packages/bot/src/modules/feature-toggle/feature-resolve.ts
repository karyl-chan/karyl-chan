/**
 * Per-guild feature resolution.
 *
 * Authoritative 3-tier precedence (matches plugin-routes admin GET):
 *   1. plugin_guild_features row for (pluginId, guildId, featureKey) — if exists
 *   2. plugin_feature_defaults row for (pluginId, featureKey) — operator default
 *   3. manifest.guild_features[].enabled_by_default — author intent
 *   4. false — final fallback
 *
 * Use this from any runtime gate that needs "is this plugin effectively
 * enabled in this guild?" — dispatchers, schedulers, anywhere a bare
 * `findEnabledFeaturesByPluginGuild(pluginId, guildId).length === 0`
 * would give a false negative (no row written but manifest defaults
 * true → plugin IS enabled, the gate should pass).
 */

import { findFeatureRowsByPluginGuild } from "./models/plugin-guild-feature.model.js";
import { findFeatureDefaultsByPlugin } from "./models/plugin-feature-default.model.js";
import type { PluginManifest } from "../plugin-system/plugin-sdk-types.js";

export async function isPluginEffectivelyEnabledInGuild(
  pluginId: number,
  guildId: string,
  manifest: PluginManifest,
): Promise<boolean> {
  const manifestFeatures = manifest.guild_features ?? [];
  if (manifestFeatures.length === 0) {
    // Plugin doesn't declare per-guild features; the only gate is the
    // plugin-level enabled flag (checked by caller).
    return true;
  }
  const [rows, defaults] = await Promise.all([
    findFeatureRowsByPluginGuild(pluginId, guildId),
    findFeatureDefaultsByPlugin(pluginId),
  ]);
  const rowByKey = new Map(rows.map((r) => [r.featureKey, r.enabled]));
  const opDefaultByKey = new Map(defaults.map((d) => [d.featureKey, d.enabled]));

  return manifestFeatures.some((feature) => {
    const rowVal = rowByKey.get(feature.key);
    if (rowVal !== undefined) return rowVal;
    const opDefault = opDefaultByKey.get(feature.key);
    if (opDefault !== undefined) return opDefault;
    return !!feature.enabled_by_default;
  });
}

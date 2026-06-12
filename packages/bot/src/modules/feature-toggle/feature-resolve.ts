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
 *
 * PM-8: now a thin delegate over the cached FeatureReachResolver so the
 * component/modal dispatch paths share the same cache + invalidation as
 * the event dispatcher and the RPC gate. Same semantics as before,
 * including featureless plugins → true (their only per-guild surface is
 * the plugin-level enabled flag, checked by the caller).
 */

import { featureReachResolver } from "./feature-reach-resolver.js";
import type { PluginManifest } from "../plugin-system/plugin-sdk-types.js";

export async function isPluginEffectivelyEnabledInGuild(
  pluginId: number,
  guildId: string,
  manifest: PluginManifest,
): Promise<boolean> {
  return featureReachResolver.hasAnyFeatureEnabledInGuild(
    pluginId,
    guildId,
    manifest,
  );
}

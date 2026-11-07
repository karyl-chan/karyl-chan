/**
 * Guild Reach (#129) — whether a plugin may serve a guild outside event
 * delivery: component / modal dispatch and guild-targeted RPC
 * (messages.send, members.get, …). Two independent grounds:
 *
 *   - Feature Reach: any declared guild feature is effectively enabled
 *     in the guild (a featureless plugin always passes — the always-on
 *     contract of FeatureReachResolver.hasAnyFeatureEnabledInGuild);
 *   - Command Reach: the plugin has a track-3 `plugin_commands[]`
 *     command the reconciler registers and that is usable in guilds.
 *
 * Owner ruling on #129: a track-3 command's follow-ups (buttons, modals,
 * replies into the guild) are authorized by the command being usable,
 * not by features. Neither a `kc:` custom_id nor an RPC call carries the
 * command it came from, so the narrowest attributable unit is the
 * plugin: a plugin with a usable track-3 command may follow up in any
 * guild that command is usable in. Track 1 feature commands never confer
 * Command Reach, and event delivery keeps its per-scope Feature Reach.
 *
 * Feature Reach is checked first (cached); the plugin_commands read only
 * runs when no feature reaches the guild, and fails closed.
 */

import type { CommandTarget } from "../command-system/command-target.js";
import { featureReachResolver } from "../feature-toggle/feature-reach-resolver.js";
import {
  findTrackThreeCommandsByPlugin,
  parsePluginCommandManifest,
  pluginCommandScopeTarget,
  type PluginCommandRow,
} from "./models/plugin-command.model.js";
import type { PluginRow } from "./models/plugin.model.js";
import { parsePluginManifest } from "./plugin-dispatch-util.js";
import type {
  ManifestPluginCommand,
  PluginManifest,
} from "./plugin-registry.service.js";

/**
 * Whether a track-3 row is one the reconciler registers with Discord —
 * the ONE copy of that decision, shared by PluginCommandSource. The one
 * check it leaves out is axis legality, which the reconciler applies
 * when deriving the Discord payload (deriveRegistrationCall); register
 * already refuses illegal axes (validateManifest V-05..V-C3), so a stored
 * row that is `live` here but rejected there means a pre-validation row.
 */
export type TrackThreeRowState =
  | { status: "live"; command: ManifestPluginCommand; target: CommandTarget }
  /** Track 1 guild feature row — PluginCommandRegistry's, not track 3. */
  | { status: "feature_row" }
  | { status: "plugin_missing" }
  /** OQ-14 guard: manifest unparseable or schema_version is not "1". */
  | { status: "unsupported_manifest" }
  | { status: "unparseable_command" }
  /** Plugin disabled / inactive, or the admin turned this command off. */
  | {
      status: "disabled";
      command: ManifestPluginCommand;
      target: CommandTarget;
    };

export function trackThreeRowState(
  row: PluginCommandRow,
  plugin: PluginRow | null,
): TrackThreeRowState {
  if (row.featureKey !== null) return { status: "feature_row" };
  if (!plugin) return { status: "plugin_missing" };
  const manifest = parsePluginManifest(plugin);
  if (!manifest || manifest.schema_version !== "1") {
    return { status: "unsupported_manifest" };
  }
  const command = parsePluginCommandManifest(row.manifestJson);
  if (!command) return { status: "unparseable_command" };
  const target = pluginCommandScopeTarget(command.scope);
  if (!plugin.enabled || plugin.status !== "active" || !row.adminEnabled) {
    return { status: "disabled", command, target };
  }
  return { status: "live", command, target };
}

/** A registered command is usable in guilds when it is registered per
 *  guild, or is global and allows the Guild interaction context. */
function usableInGuilds(
  command: ManifestPluginCommand,
  target: CommandTarget,
): boolean {
  return target === "all_guilds" || (command.contexts ?? []).includes("Guild");
}

/** Command Reach — the plugin has a registered track-3 command usable in
 *  guilds. Uncached (only consulted once Feature Reach said no); fails
 *  closed on a read error. */
export async function hasCommandReach(plugin: PluginRow): Promise<boolean> {
  let rows: PluginCommandRow[];
  try {
    rows = await findTrackThreeCommandsByPlugin(plugin.id);
  } catch {
    return false;
  }
  return rows.some((row) => {
    const state = trackThreeRowState(row, plugin);
    return (
      state.status === "live" && usableInGuilds(state.command, state.target)
    );
  });
}

/** Guild Reach — Feature Reach for any declared feature, else Command Reach. */
export async function pluginReachesGuild(
  plugin: PluginRow,
  guildId: string,
  manifest: PluginManifest,
): Promise<boolean> {
  if (
    await featureReachResolver.hasAnyFeatureEnabledInGuild(
      plugin.id,
      guildId,
      manifest,
    )
  ) {
    return true;
  }
  return hasCommandReach(plugin);
}

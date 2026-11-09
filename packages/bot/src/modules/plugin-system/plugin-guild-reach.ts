/**
 * Guild Reach (#129) — whether a plugin may serve a guild outside event
 * delivery: component / modal dispatch and guild-targeted RPC
 * (messages.send, members.get, …). Two independent grounds:
 *
 *   - Feature Reach: any declared guild feature is effectively enabled
 *     in the guild (a featureless plugin always passes — the always-on
 *     contract of FeatureReachResolver.hasAnyFeatureEnabledInGuild);
 *   - Command Reach: the plugin has a track-3 `plugin_commands[]`
 *     command registered where this guild can invoke it.
 *
 * Owner ruling on #129: a track-3 command's follow-ups (buttons, modals,
 * replies into the guild) are authorized by the command being usable,
 * not by features. Neither a `kc:` custom_id nor an RPC call carries the
 * command it came from, so the narrowest attributable unit is the
 * plugin: a plugin with a usable track-3 command may follow up in each
 * guild where that command is registered. Track 1 feature commands never confer
 * Command Reach, and event delivery keeps its per-scope Feature Reach.
 *
 * Feature Reach is checked first (cached); the plugin_commands and roster
 * reads only run when no feature reaches the guild, and fail closed.
 */

import {
  guildTarget,
  targetCovers,
  type CommandTarget,
  type ConcreteTarget,
} from "../command-system/command-target.js";
import {
  isAnyCommandOwned,
  type OwnedCommand,
} from "../command-system/reconcile.service.js";
import { featureReachResolver } from "../feature-toggle/feature-reach-resolver.js";
import {
  findTrackThreeCommandsByPlugin,
  trackThreeRowState,
} from "./models/plugin-command.model.js";
import type { PluginRow } from "./models/plugin.model.js";
import type {
  ManifestPluginCommand,
  PluginManifest,
} from "./plugin-registry.service.js";

/**
 * Where a track-3 command would have to be registered to be usable in
 * this guild: its own guild copy (scope guild), or the global command
 * when it allows the Guild interaction context. Null when no
 * registration of it can be invoked there.
 */
function registrationServing(
  command: ManifestPluginCommand,
  target: CommandTarget,
  guildId: string,
): ConcreteTarget | null {
  if (target === "global") {
    return (command.contexts ?? []).includes("Guild") ? "global" : null;
  }
  const here = guildTarget(guildId);
  return targetCovers(target, here) ? here : null;
}

/**
 * Command Reach — one of the plugin's live track-3 commands is
 * registered where this guild can invoke it. "Live" is the reconciler's
 * own decision (trackThreeRowState); "registered" is its roster
 * (reconciler_owned_commands), so a command not yet reconciled into
 * this guild grants nothing. The roster also keeps a row when Discord
 * refused the create (so stale cleanup can find it); such a command
 * still grants reach there until the reconciler drops the row. The roster is keyed by
 * name and target, not by source, so a same-named command another source
 * (a behavior) owns there would also count; the reconciler registers one
 * command per name and target, so that takes a name clash between
 * sources. Uncached (only consulted once Feature Reach said no); fails
 * closed on a read error.
 */
async function hasCommandReach(
  plugin: PluginRow,
  guildId: string,
): Promise<boolean> {
  try {
    const rows = await findTrackThreeCommandsByPlugin(plugin.id);
    const candidates: OwnedCommand[] = [];
    for (const row of rows) {
      const state = trackThreeRowState(row, plugin);
      if (state.status !== "live") continue;
      const target = registrationServing(state.command, state.target, guildId);
      if (target) candidates.push({ name: state.command.name, target });
    }
    return await isAnyCommandOwned(candidates);
  } catch {
    return false;
  }
}

/** Guild Reach — Feature Reach for any declared feature, else Command Reach. */
export async function hasGuildReach(
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
  return hasCommandReach(plugin, guildId);
}

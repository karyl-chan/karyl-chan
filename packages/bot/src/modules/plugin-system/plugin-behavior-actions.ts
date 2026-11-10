/**
 * The installed plugins' behavior actions (#127, #203), read from their
 * stored manifests (`behavior_actions`): what the admin picks from when a
 * behavior's action is a plugin action, and what a binding is checked
 * against on save. The behavior routes get it injected
 * (PluginActionCatalog, module-routes.ts) — behavior does not import
 * plugin-system.
 *
 * Every installed plugin that declares at least one action is listed,
 * disabled or offline ones too: a binding to them may be saved, and fails
 * at run time until the plugin is back (plugin-action.ts).
 */

import type { PluginActionCatalog, PluginBehaviorActions } from "../behavior/behavior-action-input.js";
import { findAllPlugins, type PluginRow } from "./models/plugin.model.js";
import { parsePluginManifest } from "./plugin-dispatch-util.js";

/** The behavior actions a plugin's current manifest declares ([] when none or unparseable). */
export function declaredBehaviorActions(plugin: PluginRow): PluginBehaviorActions["actions"] {
  const manifest = parsePluginManifest(plugin);
  const declared = Array.isArray(manifest?.behavior_actions) ? manifest.behavior_actions : [];
  return declared.map(({ key, name, description }) => ({ key, name, description }));
}

export const pluginBehaviorActionCatalog: PluginActionCatalog = {
  async list() {
    const plugins = await findAllPlugins();
    return plugins
      .map((p) => ({
        pluginKey: p.pluginKey,
        pluginName: p.name,
        enabled: p.enabled,
        status: p.status,
        actions: declaredBehaviorActions(p),
      }))
      .filter((p) => p.actions.length > 0)
      .sort((a, b) => a.pluginKey.localeCompare(b.pluginKey));
  },
};

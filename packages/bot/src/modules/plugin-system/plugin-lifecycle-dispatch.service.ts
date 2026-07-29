import { findPluginById } from "./models/plugin.model.js";
import { botEventLog } from "../bot-events/bot-event-log.js";
import { shouldRecord } from "../bot-events/bot-event-dedup.js";
import { pluginDispatcher } from "./plugin-dispatch.service.js";

/**
 * Bot → Plugin lifecycle dispatch (thin Dispatch Kind adapter over the
 * Plugin Dispatch module).
 *
 * Distinct from the regular `plugin-event-bridge` which fans `data` to
 * everyone subscribed to an event type and POSTs to a shared
 * `endpoints.events` path. Lifecycle events are addressed to a single
 * plugin (the one whose guild feature toggled) and target a separate
 * endpoint (`endpoints.plugin_lifecycle`, default `/_kc/lifecycle`) so
 * plugins owning their own `/events` route don't have to multiplex on
 * event name. An absent endpoint = plugin opted out (no onEnable /
 * onDisable hooks) — the module skips the dispatch silently; everything
 * past that point is a dispatch the plugin DECLARED it wants, so
 * failures feed dispatch health like every other signed dispatch path.
 *
 * Fire-and-forget — the route handler logging the toggle should not
 * wait on the plugin to ack before returning to the admin UI.
 */

/**
 * Fire a guild-feature enable/disable event at a specific plugin.
 * Async but fire-and-forget — callers do not await.
 *
 * The dispatch module handles delivery errors itself; the outer
 * try/catch is here to swallow DB errors from `findPluginById`
 * (Sequelize / SQLITE_BUSY) so they don't surface as unhandled
 * rejections in Node. A toggle that the plugin never hears about is
 * acceptable — the bot UI already shows the toggle took effect.
 */
export function dispatchLifecycleToPlugin(
  pluginId: number,
  eventType: "plugin.guild.enabled" | "plugin.guild.disabled",
  guildId: string,
  featureKey: string,
): void {
  void (async () => {
    try {
      const plugin = await findPluginById(pluginId);
      if (!plugin) return;
      const outcome = await pluginDispatcher.dispatch({
        kind: "lifecycle",
        plugin,
        label: eventType,
        payload: { data: { guild_id: guildId, feature_key: featureKey } },
      });
      // Gate refusals and opt-outs are silent (offline plugin, missing
      // key, broken manifest, no lifecycle endpoint) — same as before.
      if (outcome.status !== "failed") return;
      if (outcome.reason === "preflight_denied") {
        if (shouldRecord(`plugin-lifecycle-policy:${plugin.id}:${eventType}`)) {
          botEventLog.record(
            "warn",
            "bot",
            `plugin lifecycle ${eventType} → ${plugin.pluginKey} pre-flight 拒絕: ${outcome.detail}`,
            { pluginId: plugin.id, eventType },
          );
        }
      } else if (outcome.reason === "http_error") {
        if (shouldRecord(`plugin-lifecycle-fail:${plugin.id}:${eventType}`)) {
          botEventLog.record(
            "warn",
            "bot",
            `plugin lifecycle ${eventType} → ${plugin.pluginKey} returned HTTP ${outcome.httpStatus}`,
            { pluginId: plugin.id, eventType, status: outcome.httpStatus },
          );
        }
      } else if (outcome.reason === "network") {
        if (shouldRecord(`plugin-lifecycle-net:${plugin.id}:${eventType}`)) {
          botEventLog.record(
            "warn",
            "bot",
            `plugin lifecycle ${eventType} → ${plugin.pluginKey} dispatch failed: ${outcome.detail}`,
            { pluginId: plugin.id, eventType, error: outcome.detail },
          );
        }
      }
      // unresolvable_endpoint: recorded into dispatch health by the
      // module; deliberately not logged (pre-existing behavior).
    } catch (err) {
      if (shouldRecord(`plugin-lifecycle-iife:${pluginId}:${eventType}`)) {
        botEventLog.record(
          "error",
          "bot",
          `plugin lifecycle dispatch IIFE for pluginId=${pluginId} threw`,
          {
            pluginId,
            eventType,
            guildId,
            featureKey,
            error: err instanceof Error ? err.message : String(err),
          },
        );
      }
    }
  })();
}

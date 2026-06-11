import { config } from "../../config.js";
import { findPluginById, type PluginRow } from "./models/plugin.model.js";
import type { PluginManifest } from "./plugin-registry.service.js";
import { botEventLog } from "../bot-events/bot-event-log.js";
import { shouldRecord } from "../bot-events/bot-event-dedup.js";
import {
  recordDispatchFetchFailure,
  recordDispatchHttpFailure,
  recordDispatchOk,
  recordDispatchUnreachable,
} from "./plugin-dispatch-health.service.js";
import {
  buildSignedDispatchHeaders,
  parsePluginManifest,
  preflightPluginTarget,
  resolvePluginEndpoint,
} from "./plugin-dispatch-util.js";

/**
 * Bot → Plugin lifecycle dispatch.
 *
 * Distinct from the regular `plugin-event-bridge` which fans `data` to
 * everyone subscribed to an event type and POSTs to a shared
 * `endpoints.events` path. Lifecycle events are addressed to a single
 * plugin (the one whose guild feature toggled) and target a separate
 * endpoint (`endpoints.plugin_lifecycle`, default `/_kc/lifecycle`) so
 * plugins owning their own `/events` route don't have to multiplex on
 * event name.
 *
 * Fire-and-forget — the route handler logging the toggle should not
 * wait on the plugin to ack before returning to the admin UI.
 */

const DISPATCH_TIMEOUT_MS = config.plugin.dispatchTimeoutMs;

const parseManifest = parsePluginManifest;

function resolveLifecycleUrl(
  plugin: PluginRow,
  manifest: PluginManifest,
): string | null {
  const path = manifest.endpoints?.plugin_lifecycle;
  // Absent endpoint = plugin opted out (no onEnable / onDisable hooks).
  // Returning null signals to skip the dispatch entirely.
  if (!path) return null;
  return resolvePluginEndpoint(plugin.url, path);
}

async function postLifecycleToPlugin(
  plugin: PluginRow,
  eventType: string,
  data: unknown,
  signingKey: string,
): Promise<void> {
  const manifest = parseManifest(plugin);
  if (!manifest) return;
  // No-endpoint (opted out) is the only silent skip; everything past
  // this point is a dispatch the plugin DECLARED it wants, so failures
  // feed dispatch health like every other signed dispatch path.
  const url = resolveLifecycleUrl(plugin, manifest);
  if (!url) {
    if (manifest.endpoints?.plugin_lifecycle) {
      recordDispatchUnreachable(
        plugin.pluginKey,
        "lifecycle",
        eventType,
        "unresolvable plugin endpoint URL",
      );
    }
    return;
  }

  const preflight = await preflightPluginTarget(url);
  if (!preflight.ok) {
    recordDispatchUnreachable(
      plugin.pluginKey,
      "lifecycle",
      eventType,
      preflight.reason,
    );
    if (
      shouldRecord(`plugin-lifecycle-policy:${plugin.id}:${eventType}`)
    ) {
      botEventLog.record(
        "warn",
        "bot",
        `plugin lifecycle ${eventType} → ${plugin.pluginKey} pre-flight 拒絕: ${preflight.reason}`,
        { pluginId: plugin.id, eventType },
      );
    }
    return;
  }

  const body = JSON.stringify({ type: eventType, data });
  const headers = buildSignedDispatchHeaders(signingKey, url, body);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), DISPATCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body,
      // Don't follow redirects past the assertPluginTarget host check — a
      // 3xx Location would bypass the SSRF guard (cf. webhook-forwarder).
      redirect: "manual",
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      recordDispatchHttpFailure(
        plugin.pluginKey,
        "lifecycle",
        eventType,
        res.status,
        text,
      );
      if (
        shouldRecord(`plugin-lifecycle-fail:${plugin.id}:${eventType}`)
      ) {
        botEventLog.record(
          "warn",
          "bot",
          `plugin lifecycle ${eventType} → ${plugin.pluginKey} returned HTTP ${res.status}`,
          { pluginId: plugin.id, eventType, status: res.status },
        );
      }
    } else {
      recordDispatchOk(plugin.pluginKey, "lifecycle", res.status);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    recordDispatchFetchFailure(plugin.pluginKey, "lifecycle", eventType, err);
    if (shouldRecord(`plugin-lifecycle-net:${plugin.id}:${eventType}`)) {
      botEventLog.record(
        "warn",
        "bot",
        `plugin lifecycle ${eventType} → ${plugin.pluginKey} dispatch failed: ${msg}`,
        { pluginId: plugin.id, eventType, error: msg },
      );
    }
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fire a guild-feature enable/disable event at a specific plugin.
 * Async but fire-and-forget — callers do not await.
 *
 * The inner `postLifecycleToPlugin` handles HTTP errors itself; the
 * outer try/catch is here to swallow DB errors from `findPluginById`
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
      if (!plugin || !plugin.enabled || plugin.status !== "active") return;
      const signingKey = plugin.dispatchHmacKey;
      if (!signingKey) return;
      await postLifecycleToPlugin(
        plugin,
        eventType,
        { guild_id: guildId, feature_key: featureKey },
        signingKey,
      );
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

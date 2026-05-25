import { config } from "../../config.js";
import { findPluginById, type PluginRow } from "./models/plugin.model.js";
import type { PluginManifest } from "./plugin-registry.service.js";
import { botEventLog } from "../bot-events/bot-event-log.js";
import { shouldRecord } from "../bot-events/bot-event-dedup.js";
import {
  assertPluginTarget,
  HostPolicyError,
} from "../../utils/host-policy.js";
import { buildOutboundSignatureHeaders } from "../../utils/hmac.js";

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

function parseManifest(plugin: PluginRow): PluginManifest | null {
  try {
    return JSON.parse(plugin.manifestJson) as PluginManifest;
  } catch {
    return null;
  }
}

function resolveLifecycleUrl(
  plugin: PluginRow,
  manifest: PluginManifest,
): string | null {
  const path = manifest.endpoints?.plugin_lifecycle;
  // Absent endpoint = plugin opted out (no onEnable / onDisable hooks).
  // Returning null signals to skip the dispatch entirely.
  if (!path) return null;
  try {
    return new URL(path, plugin.url).toString();
  } catch {
    return null;
  }
}

async function postLifecycleToPlugin(
  plugin: PluginRow,
  eventType: string,
  data: unknown,
  signingKey: string,
): Promise<void> {
  const manifest = parseManifest(plugin);
  if (!manifest) return;
  const url = resolveLifecycleUrl(plugin, manifest);
  if (!url) return;

  const parsedUrl = new URL(url);
  const port = parsedUrl.port
    ? Number(parsedUrl.port)
    : parsedUrl.protocol === "https:"
      ? 443
      : 80;
  try {
    await assertPluginTarget(parsedUrl.hostname, port);
  } catch (err) {
    if (!(err instanceof HostPolicyError)) throw err;
    if (
      shouldRecord(`plugin-lifecycle-policy:${plugin.id}:${eventType}`)
    ) {
      botEventLog.record(
        "warn",
        "bot",
        `plugin lifecycle ${eventType} → ${plugin.pluginKey} pre-flight 拒絕: ${err.message}`,
        { pluginId: plugin.id, eventType },
      );
    }
    return;
  }

  const body = JSON.stringify({ type: eventType, data });
  const sigHeaders = buildOutboundSignatureHeaders(
    signingKey,
    "POST",
    parsedUrl.pathname,
    body,
  );
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), DISPATCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...sigHeaders,
      },
      body,
      signal: ctrl.signal,
    });
    if (!res.ok) {
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
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
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
 */
export function dispatchLifecycleToPlugin(
  pluginId: number,
  eventType: "plugin.guild.enabled" | "plugin.guild.disabled",
  guildId: string,
  featureKey: string,
): void {
  void (async () => {
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
  })();
}

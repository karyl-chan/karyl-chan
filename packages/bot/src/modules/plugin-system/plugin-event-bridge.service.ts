import { config } from "../../config.js";
import {
  findAllPlugins,
  findPluginsByIds,
  type PluginRow,
} from "./models/plugin.model.js";
import type { PluginManifest } from "./plugin-registry.service.js";
import { botEventLog } from "../bot-events/bot-event-log.js";
import { shouldRecord } from "../bot-events/bot-event-dedup.js";
import {
  assertPluginTarget,
  HostPolicyError,
} from "../../utils/host-policy.js";
import { buildOutboundSignatureHeaders } from "../../utils/hmac.js";
import {
  PluginDispatchPool,
  DEFAULT_DISPATCH_POOL_OPTIONS,
} from "./plugin-dispatch-pool.js";

/**
 * Bot → Plugin event dispatch. Plugins declare which event types
 * they're interested in via their manifest's
 *
 *   guild_features[].events_subscribed   (per-feature)
 *   events_subscribed_global             (plugin-wide fallback)
 *
 * fields. We index those at register / enable time so the hot path
 * (every Discord event the bot receives) doesn't have to walk the
 * full plugins table.
 *
 * Dispatch is fire-and-forget: we POST to plugin.url + manifest's
 * endpoints.events (default `/events`) with HMAC headers, then move
 * on. Plugins that want to act on the event call back through the
 * /api/plugin/* RPC routes.
 */

const DEFAULT_EVENTS_PATH = "/events";

/**
 * Per-plugin outbound dispatch pool: HTTP keep-alive + concurrency
 * cap + circuit breaker + connect-refused retry. Phase 0.3.
 * Singleton because pools are keyed by pluginKey internally.
 */
const dispatchPool = new PluginDispatchPool({
  ...DEFAULT_DISPATCH_POOL_OPTIONS,
  requestTimeoutMs: config.plugin.dispatchTimeoutMs,
});

/** Test-only — for the pool itself. */
export function __getDispatchPoolForTests(): PluginDispatchPool {
  return dispatchPool;
}

/** Snapshot of per-plugin pool state for metrics + admin UI. */
export function getDispatchPoolSnapshot(): ReturnType<
  PluginDispatchPool["snapshot"]
> {
  return dispatchPool.snapshot();
}

/** Stop the dispatch pool — called from gracefulShutdown. */
export async function stopDispatchPool(): Promise<void> {
  await dispatchPool.stop();
}

/**
 * In-memory index: event_type → Set<pluginId>. Rebuilt on startup
 * and whenever a plugin registers / enables / disables. Reading is
 * synchronous; the actual fan-out POSTs are async.
 */
class EventIndex {
  private map = new Map<string, Set<number>>();

  set(map: Map<string, Set<number>>): void {
    this.map = map;
  }

  subscribers(eventType: string): number[] {
    const s = this.map.get(eventType);
    return s ? Array.from(s) : [];
  }

  hasSubscribers(eventType: string): boolean {
    const s = this.map.get(eventType);
    return !!s && s.size > 0;
  }

  size(): number {
    return this.map.size;
  }
}

const index = new EventIndex();

function parseManifest(plugin: PluginRow): PluginManifest | null {
  try {
    return JSON.parse(plugin.manifestJson) as PluginManifest;
  } catch {
    return null;
  }
}

function collectSubscribedEvents(manifest: PluginManifest): Set<string> {
  const out = new Set<string>();
  for (const e of manifest.events_subscribed_global ?? []) {
    if (typeof e === "string" && e.length > 0) out.add(e);
  }
  for (const f of manifest.guild_features ?? []) {
    for (const e of f.events_subscribed ?? []) {
      if (typeof e === "string" && e.length > 0) out.add(e);
    }
  }
  return out;
}

/**
 * Walk the plugins table and rebuild the in-memory event subscription
 * index. Idempotent; safe to call after every register/enable/disable
 * even if multiple back-to-back changes happen.
 */
export async function rebuildEventIndex(): Promise<void> {
  const all = await findAllPlugins();
  const m = new Map<string, Set<number>>();
  for (const p of all) {
    if (!p.enabled || p.status !== "active") continue;
    const manifest = parseManifest(p);
    if (!manifest) continue;
    const events = collectSubscribedEvents(manifest);
    for (const ev of events) {
      let set = m.get(ev);
      if (!set) {
        set = new Set();
        m.set(ev, set);
      }
      set.add(p.id);
    }
  }
  index.set(m);
}

function resolveEventsUrl(
  plugin: PluginRow,
  manifest: PluginManifest,
): string | null {
  const path = manifest.endpoints?.events ?? DEFAULT_EVENTS_PATH;
  try {
    return new URL(path, plugin.url).toString();
  } catch {
    return null;
  }
}

async function postEventToPlugin(
  plugin: PluginRow,
  eventType: string,
  data: unknown,
  signingKey: string,
): Promise<void> {
  const manifest = parseManifest(plugin);
  if (!manifest) return;
  const url = resolveEventsUrl(plugin, manifest);
  if (!url) return;

  const parsedEventsUrl = new URL(url);
  const eventsPort = parsedEventsUrl.port
    ? Number(parsedEventsUrl.port)
    : parsedEventsUrl.protocol === "https:"
      ? 443
      : 80;
  try {
    await assertPluginTarget(parsedEventsUrl.hostname, eventsPort);
  } catch (err) {
    if (!(err instanceof HostPolicyError)) throw err;
    if (shouldRecord(`plugin-dispatch-policy:${plugin.id}:${eventType}`)) {
      botEventLog.record(
        "warn",
        "bot",
        `plugin event ${eventType} → ${plugin.pluginKey} pre-flight 拒絕: ${err.message}`,
        { pluginId: plugin.id, eventType },
      );
    }
    return;
  }

  const body = JSON.stringify({ type: eventType, data });
  const sigHeaders = buildOutboundSignatureHeaders(
    signingKey,
    "POST",
    parsedEventsUrl.pathname,
    body,
  );

  const outcome = await dispatchPool.post(
    plugin.pluginKey,
    url,
    sigHeaders,
    body,
  );
  if (outcome.ok) return;
  // Per (plugin, eventType, reason) dedup keeps a wedged plugin from
  // flooding the bot event log at message-traffic rate.
  const reason = outcome.reason;
  if (shouldRecord(`plugin-dispatch-${reason}:${plugin.id}:${eventType}`)) {
    botEventLog.record(
      "warn",
      "bot",
      `plugin event ${eventType} → ${plugin.pluginKey} ${reason}: ${outcome.message}`,
      {
        pluginId: plugin.id,
        eventType,
        reason,
        ...(outcome.status !== undefined ? { status: outcome.status } : {}),
      },
    );
  }
}

/**
 * Fan out a Discord event to every plugin subscribed to its type.
 * Returns immediately; the dispatch itself runs in the background.
 * Plugins that are slow / down don't block the bot's main loop.
 *
 * TODO(event-name-whitelist): `eventType` is a free-form string here
 * and in the manifest's `events_subscribed*` fields, so a plugin
 * manifest with a typo (e.g. "guild.voice_state_updates" plural)
 * registers successfully but never receives the event with no
 * diagnostic. We should keep a canonical KNOWN_EVENT_TYPES set and
 * surface a soft-warn from validateManifest on unknown subscriptions.
 * Pre-existing design gap; flagged during Workpack A code review.
 */
export function dispatchEventToPlugins(eventType: string, data: unknown): void {
  if (!index.hasSubscribers(eventType)) return;
  const ids = index.subscribers(eventType);
  // Fire all dispatches in parallel; we do not await. Errors per
  // plugin are logged inside postEventToPlugin and do not propagate.
  // The outer findPluginsByIds (a DB read) is wrapped in try/catch so
  // a transient SQLITE_BUSY cannot escape this fire-and-forget IIFE as
  // an unhandled rejection — Node would otherwise terminate the bot
  // process under --unhandled-rejections=throw.
  void (async () => {
    try {
      const pluginMap = await findPluginsByIds(ids);
      await Promise.allSettled(
        ids.map(async (id) => {
          const plugin = pluginMap.get(id);
          if (!plugin || !plugin.enabled || plugin.status !== "active") return;
          const signingKey = plugin.dispatchHmacKey;
          if (!signingKey) return;
          await postEventToPlugin(plugin, eventType, data, signingKey);
        }),
      );
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      botEventLog.record(
        "error",
        "bot",
        `dispatchEventToPlugins(${eventType}) failed: ${m}`,
      );
    }
  })();
}

/** Test-only / startup hook to read the current index snapshot. */
export function getEventIndexSize(): number {
  return index.size();
}

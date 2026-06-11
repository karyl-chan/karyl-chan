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
  TRACEPARENT_HEADER,
  newTraceContext,
} from "../../utils/trace-context.js";
import {
  pluginEventDispatchDuration,
  pluginEventDispatchTotal,
} from "../web-core/metrics.js";
import {
  PluginDispatchPool,
  DEFAULT_DISPATCH_POOL_OPTIONS,
  type DispatchOutcome,
} from "./plugin-dispatch-pool.js";
import {
  recordDispatchAttempt,
  classifyDispatchHttpFailure,
  type DispatchAttempt,
} from "./plugin-dispatch-health.service.js";
import {
  EventIndex,
  collectSubscribedEvents,
  parseManifestJson,
} from "./plugin-event-index.js";
import { getPluginEventBus } from "../../adapters/registry.js";
import type { PluginEventBus } from "../../adapters/plugin-event-bus.js";

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
 * Map a pool outcome onto the dispatch-health vocabulary (PM-7.9.1).
 * Failure outcomes don't carry a body, so the awaiting-register
 * refinement of 503s isn't available on this path — a plain
 * `http_error` is recorded instead. Pool-level timeouts surface as
 * undici errors and land in `network`.
 */
function dispatchAttemptFromOutcome(
  outcome: DispatchOutcome,
  eventType: string,
): Omit<DispatchAttempt, "at"> {
  if (outcome.ok) {
    return { ok: true, source: "event", status: outcome.status };
  }
  return {
    ok: false,
    source: "event",
    ...(outcome.status !== undefined ? { status: outcome.status } : {}),
    failureClass:
      outcome.reason === "http_error"
        ? classifyDispatchHttpFailure(outcome.status ?? 0, "")
        : outcome.reason === "connect_refused"
          ? "network"
          : outcome.reason,
    message: `${eventType}: ${outcome.message}`,
  };
}

/**
 * Per-plugin outbound dispatch pool: HTTP keep-alive + concurrency
 * cap + circuit breaker + connect-refused retry.
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
 * Drop the per-plugin dispatch pool entry (closes keep-alive sockets,
 * resets breaker state). Call on plugin delete / URL change /
 * re-register so a previously-tripped breaker doesn't survive the
 * operator's recovery action.
 */
export function dropDispatchPoolForPlugin(pluginKey: string): void {
  dispatchPool.drop(pluginKey);
}

const index = new EventIndex();

/**
 * Optional out-of-process event bus (PR-1.2). Resolved lazily so tests
 * that set `EVENT_BUS` after importing this module still pick it up, and
 * so the default-off path never constructs a Redis client.
 *
 *   - `null` (the default — EVENT_BUS unset / http / inprocess): events
 *     fan out over HTTP via `postEventToPlugin`, byte-for-byte the
 *     pre-PR-1 behaviour.
 *   - non-null (EVENT_BUS=redis-streams): the bot XADDs the event to the
 *     shared per-type stream and the SDK consumer picks it up. The bot
 *     is then decoupled from plugin readiness — a restarting plugin
 *     drains its backlog from Redis instead of dropping events.
 *
 * `undefined` means "not yet resolved"; `null` is a resolved "no bus".
 */
let eventBus: PluginEventBus | null | undefined;

function resolveEventBus(): PluginEventBus | null {
  if (eventBus === undefined) eventBus = getPluginEventBus();
  return eventBus;
}

/** Test-only — drop the cached bus so the next dispatch re-reads EVENT_BUS. */
export function __resetEventBusForTests(): void {
  eventBus = undefined;
}

function parseManifest(plugin: PluginRow): PluginManifest | null {
  return parseManifestJson(plugin.manifestJson);
}

/**
 * Walk the plugins table and rebuild the in-memory event subscription
 * index. Called once at startup. Subsequent mutations should call
 * `applyPluginChange` / `removePluginFromIndex` instead — those apply
 * O(|prev ∪ next|) deltas without rescanning the whole table.
 */
export async function rebuildEventIndex(): Promise<void> {
  const all = await findAllPlugins();
  const m = new Map<string, Set<number>>();
  const perPlugin = new Map<number, Set<string>>();
  for (const p of all) {
    if (!p.enabled || p.status !== "active") continue;
    const manifest = parseManifest(p);
    if (!manifest) continue;
    const events = collectSubscribedEvents(manifest);
    if (events.size === 0) continue;
    perPlugin.set(p.id, events);
    for (const ev of events) {
      let set = m.get(ev);
      if (!set) {
        set = new Set();
        m.set(ev, set);
      }
      set.add(p.id);
    }
  }
  index.setAll(m, perPlugin);
}

/**
 * Incremental update — call after register / setEnabled /
 * heartbeat-expire to keep the event index in sync without a full
 * table walk.
 *
 * Pass the post-mutation `PluginRow` (or just enough of it). When the
 * plugin should not receive dispatch (disabled OR status!=='active'
 * OR no parseable manifest), this acts as a removal.
 */
export function applyPluginChange(plugin: PluginRow): void {
  if (!plugin.enabled || plugin.status !== "active") {
    index.applyPlugin(plugin.id, new Set());
    return;
  }
  const manifest = parseManifest(plugin);
  if (!manifest) {
    index.applyPlugin(plugin.id, new Set());
    return;
  }
  index.applyPlugin(plugin.id, collectSubscribedEvents(manifest));
}

/** Drop a plugin from the index — e.g. on hard delete or heartbeat expire. */
export function removePluginFromIndex(pluginId: number): void {
  index.applyPlugin(pluginId, new Set());
}

/** Test-only — read the index state. */
export function __snapshotEventIndexForTests(): {
  map: Map<string, Set<number>>;
  perPlugin: Map<number, Set<string>>;
} {
  return index.snapshot();
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

  // Stamp a fresh W3C trace context onto every outbound event
  // dispatch. Discord events arriving at the bot don't carry a
  // parent traceparent, so this is the root span for the
  // bot→plugin→reaction chain. Plugins read this off the SDK's
  // `ctx.traceparent` and forward it on any RPC they make back.
  const trace = newTraceContext();
  const headers = {
    ...sigHeaders,
    [TRACEPARENT_HEADER]: trace.traceparent,
  };
  const startedAt = Date.now();
  const outcome = await dispatchPool.post(
    plugin.pluginKey,
    url,
    headers,
    body,
  );
  const elapsedSeconds = (Date.now() - startedAt) / 1000;
  // Per-(plugin, event_type) latency + outcome counters.
  // `shard_id` carries this process's shard label (defaults to "0" in
  // single-shard deployments).
  pluginEventDispatchDuration.observe(
    { event_type: eventType, plugin_id: plugin.pluginKey, shard_id: String(config.bot.shardId) },
    elapsedSeconds,
  );
  pluginEventDispatchTotal.inc({
    event_type: eventType,
    outcome: outcome.ok ? "ok" : outcome.reason,
    plugin_id: plugin.pluginKey,
    shard_id: String(config.bot.shardId),
  });
  recordDispatchAttempt(plugin.pluginKey, dispatchAttemptFromOutcome(outcome, eventType));
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
 * Pre-existing design gap.
 */
export function dispatchEventToPlugins(eventType: string, data: unknown): void {
  // Subscription gate applies to BOTH transports: an event no plugin
  // subscribes to is dropped here so we never grow a Redis stream for a
  // type nobody consumes (and the HTTP path has nothing to POST to).
  if (!index.hasSubscribers(eventType)) return;

  // Streams transport (EVENT_BUS=redis-streams): hand the event to the
  // bus and return. The bus XADDs to the shared per-type stream; the
  // per-plugin SDK consumers fan it out + ACK on their own cursors, so
  // the bot no longer walks the plugins table or HMAC-signs per plugin
  // on the hot path. `dispatch` is fire-and-forget (errors swallowed
  // inside the impl), same contract as the HTTP path.
  const bus = resolveEventBus();
  if (bus) {
    bus.dispatch(eventType, data);
    return;
  }

  // Default / fallback: HTTP fan-out, unchanged from pre-PR-1.
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

import { config } from "../../config.js";
import {
  findAllPlugins,
  findPluginsByIds,
  type PluginRow,
} from "./models/plugin.model.js";
import type { PluginManifest } from "./plugin-registry.service.js";
import { botEventLog } from "../bot-events/bot-event-log.js";
import { shouldRecord } from "../bot-events/bot-event-dedup.js";
import { parsePluginManifest } from "./plugin-dispatch-util.js";
import {
  EventIndex,
  collectEventRoutes,
  type EventScope,
} from "./plugin-event-index.js";
import { onPluginChange } from "./plugin-changes.js";
import { pluginDispatcher } from "./plugin-dispatch.service.js";

/**
 * Bot → Plugin event routing (the index half of event dispatch; the
 * delivery half lives in the Plugin Dispatch module). Plugins declare
 * which event types they're interested in via their manifest's
 *
 *   guild_features[].events_subscribed   (per-feature, guild-gated)
 *   events_subscribed_global             (approval-gated firehose)
 *
 * fields. We index those at register / enable time so the hot path
 * (every Discord event the bot receives) doesn't have to walk the
 * full plugins table.
 *
 * PM-8 reach enforcement: a feature-scoped subscription is delivered
 * only when its owning feature is effectively enabled (3-tier chain)
 * in the event's guild; a global subscription is delivered only when
 * the operator approved it (PLUGIN_AUTO_APPROVE=true approves all
 * declared ones — resolved at index build, so an unapproved global
 * subscription has no route at all). Inbound visibility therefore
 * follows the same per-guild consent the RPC gate enforces outbound.
 * The per-event reach gate itself runs inside the dispatch module.
 *
 * Dispatch is fire-and-forget: the module POSTs to plugin.url +
 * manifest's endpoints.events (default `/events`) with HMAC headers —
 * or XADDs into the plugin's mailbox stream when EVENT_BUS is set —
 * then we move on. Plugins that want to act on the event call back
 * through the /api/plugin/* RPC routes.
 */

// Pool management stays importable from the bridge: the pool is owned
// by the Plugin Dispatch module (it's the event transport), these
// re-exports keep the registry / routes / shutdown import surface and
// the tests that mock this module unchanged.
export {
  getDispatchPoolSnapshot,
  stopDispatchPool,
  dropDispatchPoolForPlugin,
} from "./plugin-dispatch.service.js";

const index = new EventIndex();

/** Per-row memoized manifest parse (shared canonical helper). */
const parseManifest = parsePluginManifest;

/**
 * Resolve the GRANTED global subscription set for a plugin: with
 * PLUGIN_AUTO_APPROVE (default) every declared global subscription is
 * granted — pre-PM-8 rows whose `approvedGlobalEventSubs` is NULL keep
 * working without a re-register. With auto-approve off, only the
 * persisted admin-approved set (∩ declared) is granted.
 */
function grantedGlobalSubs(
  plugin: PluginRow,
  manifest: PluginManifest,
): Set<string> {
  const declared = (manifest.events_subscribed_global ?? []).filter(
    (e): e is string => typeof e === "string" && e.length > 0,
  );
  if (config.plugin.autoApproveScopes) return new Set(declared);
  const approved = new Set(plugin.approvedGlobalEventSubs);
  return new Set(declared.filter((e) => approved.has(e)));
}

function routesFor(plugin: PluginRow): Map<string, EventScope[]> {
  const manifest = parseManifest(plugin);
  if (!manifest) return new Map();
  return collectEventRoutes(manifest, grantedGlobalSubs(plugin, manifest));
}

/**
 * Walk the plugins table and rebuild the in-memory event route index.
 * Called once at startup. Subsequent mutations reach the index via
 * Plugin Change notifications (plugin-changes.ts), which apply
 * O(|prev ∪ next|) deltas without rescanning the whole table.
 */
export async function rebuildEventIndex(): Promise<void> {
  const all = await findAllPlugins();
  const perPlugin = new Map<number, Map<string, EventScope[]>>();
  for (const p of all) {
    if (!p.enabled || p.status !== "active") continue;
    const routes = routesFor(p);
    if (routes.size === 0) continue;
    perPlugin.set(p.id, routes);
  }
  index.setAll(perPlugin);
}

/**
 * Incremental index update on a plugin-lifecycle mutation — applies the
 * post-mutation `PluginRow` without a full table walk. When the plugin
 * should not receive dispatch (disabled OR status!=='active' OR no
 * parseable manifest), this acts as a removal. Driven by the Plugin
 * Change subscription below; mutation owners emit, they don't call in.
 */
function applyPluginChange(plugin: PluginRow): void {
  if (!plugin.enabled || plugin.status !== "active") {
    index.applyPlugin(plugin.id, new Map());
    return;
  }
  index.applyPlugin(plugin.id, routesFor(plugin));
}

// The event index reacts to Plugin Changes: a lifecycle mutation
// re-derives the plugin's routes from its post-mutation row; a gone
// plugin (row: null) is dropped. One-guild feature writes and
// operator-default changes don't alter routes (feature reach is
// enforced per-event via featureReachResolver, which subscribes to the
// same notifications independently) — skipped.
onPluginChange((change) => {
  if (change.guildId !== undefined || change.row === undefined) return;
  if (change.row === null) {
    index.applyPlugin(change.pluginId, new Map());
    return;
  }
  applyPluginChange(change.row);
});

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
export function dispatchEventToPlugins(
  eventType: string,
  data: unknown,
  guildId?: string | null,
): void {
  // Subscription gate applies to BOTH transports: an event no plugin
  // subscribes to is dropped here so we never grow a Redis stream for a
  // type nobody consumes (and the HTTP path has nothing to POST to).
  if (!index.hasSubscribers(eventType)) return;

  const routes = index.routes(eventType);

  // Per-plugin gate + delivery run inside the Plugin Dispatch module —
  // both transports go through the SAME gate: the streams bus is
  // per-plugin (one mailbox stream each), so an event the gate
  // withholds is never observable by the plugin on either path.
  //
  // Fire all dispatches in parallel; we do not await. Per-plugin errors
  // surface as `failed` outcomes and are logged below with per-(plugin,
  // eventType, reason) dedup so a wedged plugin can't flood the bot
  // event log at message-traffic rate. The outer findPluginsByIds (a DB
  // read) is wrapped in try/catch so a transient SQLITE_BUSY cannot
  // escape this fire-and-forget IIFE as an unhandled rejection — Node
  // would otherwise terminate the bot process under
  // --unhandled-rejections=throw.
  void (async () => {
    try {
      const pluginMap = await findPluginsByIds(routes.map((r) => r.pluginId));
      await Promise.allSettled(
        routes.map(async ({ pluginId, scopes }) => {
          const plugin = pluginMap.get(pluginId);
          if (!plugin) return;
          const outcome = await pluginDispatcher.dispatch({
            kind: "event",
            plugin,
            guildId,
            scopes,
            label: eventType,
            payload: { data },
          });
          if (outcome.status !== "failed") return;
          // Unresolvable endpoint: recorded into dispatch health by the
          // module; deliberately not logged (pre-existing behavior).
          if (outcome.reason === "unresolvable_endpoint") return;
          if (outcome.reason === "preflight_denied") {
            if (shouldRecord(`plugin-dispatch-policy:${plugin.id}:${eventType}`)) {
              botEventLog.record(
                "warn",
                "bot",
                `plugin event ${eventType} → ${plugin.pluginKey} pre-flight 拒絕: ${outcome.detail}`,
                { pluginId: plugin.id, eventType },
              );
            }
            return;
          }
          const reason = outcome.reason;
          if (shouldRecord(`plugin-dispatch-${reason}:${plugin.id}:${eventType}`)) {
            botEventLog.record(
              "warn",
              "bot",
              `plugin event ${eventType} → ${plugin.pluginKey} ${reason}: ${outcome.detail}`,
              {
                pluginId: plugin.id,
                eventType,
                reason,
                ...(outcome.httpStatus !== undefined
                  ? { status: outcome.httpStatus }
                  : {}),
              },
            );
          }
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

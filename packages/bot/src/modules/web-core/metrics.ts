/**
 * Prometheus metrics registry for the bot.
 *
 * Exposed at /api/metrics (auth-bypassed, scrape from internal network
 * only — assume the LB / firewall blocks public access). Default
 * Node.js metrics (process_cpu_seconds, nodejs_eventloop_lag, heap)
 * are always on; business metrics are added incrementally as they
 * justify the cardinality.
 *
 * Cardinality discipline: never label by user id, guild id, channel
 * id, or message id — those are unbounded and explode Prom
 * storage. Path-template labels (e.g. /api/guilds/:guildId/...) are
 * fine because they're bounded by the route table.
 */
import {
  collectDefaultMetrics,
  Counter,
  Gauge,
  Histogram,
  Registry,
} from "prom-client";
import type { Client } from "discord.js";
import { dmEventBus } from "../dm-inbox/dm-event-bus.js";
import { guildChannelEventBus } from "../guild-management/guild-channel-event-bus.js";
import { pluginRegistry } from "../plugin-system/plugin-registry.service.js";
import { config } from "../../config.js";

/** This process's shard id as a label value. Stamped on every
 *  per-plugin / per-event metric so a multi-shard Prometheus scrape
 *  can group by it. Single-shard deployments see `"0"`. */
const SHARD_ID = String(config.bot.shardId);

export const metricsRegistry = new Registry();

// Stamp `service` on every series (default Node metrics included) so the
// metrics share one identity with the structured logs (logger.ts) and the
// OTel resource (observability/otel.ts) — logs/metrics/traces all key off
// the same service name in the aggregator. Matches the OTel default.
// shard_id is intentionally NOT a default label: business metrics already
// carry it explicitly, and for the rest each shard is a distinct Prometheus
// scrape target, so the target's instance/job label already separates them.
metricsRegistry.setDefaultLabels({
  service: (process.env.OTEL_SERVICE_NAME ?? "").trim() || "karyl-bot",
});

collectDefaultMetrics({
  register: metricsRegistry,
  prefix: "karyl_",
});

// HTTP request counter — labelled by method + status + matched route
// template (Fastify exposes request.routerPath / request.routeOptions.url).
export const httpRequestsTotal = new Counter({
  name: "karyl_http_requests_total",
  help: "Total HTTP requests handled by Fastify",
  labelNames: ["method", "status_code", "route"] as const,
  registers: [metricsRegistry],
});

export const httpRequestDuration = new Histogram({
  name: "karyl_http_request_duration_seconds",
  help: "HTTP request duration in seconds",
  labelNames: ["method", "status_code", "route"] as const,
  // Buckets tuned for an admin/bot-internal API: most requests should
  // be sub-100ms; anything past 1s is interesting.
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [metricsRegistry],
});

// Plugin event dispatch counter — counts every fanout from
// plugin-event-bridge to a plugin endpoint. Labels:
//   - event_type: bounded by the manifest event set
//   - outcome:    "ok" / "shed" / "breaker_open" / "connect_refused"
//                  / "network" / "http_error"
//   - plugin_id:  bounded by registered plugin count (typically ≤30)
//   - shard_id:   this process's shard label (defaults to "0" in
//                  single-shard deployments)
export const pluginEventDispatchTotal = new Counter({
  name: "karyl_plugin_event_dispatch_total",
  help: "Plugin event dispatches fanned out from plugin-event-bridge",
  labelNames: ["event_type", "outcome", "plugin_id", "shard_id"] as const,
  registers: [metricsRegistry],
});

// Plugin event dispatch latency — wall-clock time from postEventToPlugin
// entry to outcome (success or failure). Buckets stretch to 30s to
// cover the timeout ceiling + retry; the long tail is the most
// interesting part operationally.
export const pluginEventDispatchDuration = new Histogram({
  name: "karyl_plugin_event_dispatch_duration_seconds",
  help: "Wall-clock duration of plugin event dispatches",
  labelNames: ["event_type", "plugin_id", "shard_id"] as const,
  buckets: [0.005, 0.025, 0.1, 0.5, 1, 2.5, 5, 10, 30],
  registers: [metricsRegistry],
});

// Audit log write counter — admin actions written to admin_audit_log.
// Labelled by action category (canonical token like 'admin.create').
export const auditLogWritesTotal = new Counter({
  name: "karyl_audit_log_writes_total",
  help: "Admin audit log entries written",
  labelNames: ["action"] as const,
  registers: [metricsRegistry],
});

// Bot event log write counter — labelled by level + category. Mirrors
// botEventLog.record(level, category, ...) without echoing the message.
export const botEventLogWritesTotal = new Counter({
  name: "karyl_bot_event_log_writes_total",
  help: "Structured bot event log entries written",
  labelNames: ["level", "category"] as const,
  registers: [metricsRegistry],
});

// SSE backpressure disconnection counter — incremented when a slow SSE
// client's write buffer exceeds the threshold and the connection is
// force-destroyed. Labelled by path template (bounded cardinality).
export const sseBackpressureDisconnectsTotal = new Counter({
  name: "karyl_sse_backpressure_disconnects_total",
  help: "SSE connections force-closed due to write buffer backpressure",
  labelNames: ["path"] as const,
  registers: [metricsRegistry],
});

// Gauges read at scrape time via collect() callbacks so we never
// double-write or drift.
let botRef: Client | null = null;

export function setMetricsBotClient(bot: Client): void {
  botRef = bot;
}

// These Gauges are write-only via their `collect()` callbacks and
// self-register through `registers`, so nothing else references them — but
// we still bind each to a name so they aren't mistaken for a discarded
// `new` expression.
export const botGuildCountGauge = new Gauge({
  name: "karyl_bot_guild_count",
  help: "Number of guilds the bot is currently in",
  registers: [metricsRegistry],
  collect() {
    this.set(botRef?.guilds.cache.size ?? 0);
  },
});

export const botUserCacheSizeGauge = new Gauge({
  name: "karyl_bot_user_cache_size",
  help: "Number of users currently in the bot's user cache",
  registers: [metricsRegistry],
  collect() {
    this.set(botRef?.users.cache.size ?? 0);
  },
});

export const dmSseConnectionsGauge = new Gauge({
  name: "karyl_dm_sse_connections",
  help: "Active DM event-bus subscribers (SSE connections + others)",
  registers: [metricsRegistry],
  collect() {
    // EventEmitter exposes listenerCount; dm-event-bus uses 'event'
    // as its single channel.
    const count =
      (
        dmEventBus as unknown as {
          emitter?: { listenerCount: (e: string) => number };
        }
      ).emitter?.listenerCount("event") ?? 0;
    this.set(count);
  },
});

export const guildChannelSseConnectionsGauge = new Gauge({
  name: "karyl_guild_channel_sse_connections",
  help: "Active guild-channel event-bus subscribers",
  registers: [metricsRegistry],
  collect() {
    const count =
      (
        guildChannelEventBus as unknown as {
          emitter?: { listenerCount: (e: string) => number };
        }
      ).emitter?.listenerCount("event") ?? 0;
    this.set(count);
  },
});

export const pluginActiveCountGauge = new Gauge({
  name: "karyl_plugin_active_count",
  help: "Plugins currently registered and (best-effort) alive",
  registers: [metricsRegistry],
  async collect() {
    try {
      const list = await pluginRegistry.list();
      const active = list.filter((p) => p.status === "active").length;
      this.set(active);
    } catch {
      this.set(0);
    }
  },
});

// Per-plugin dispatch pool stats. Read from the pool's snapshot at
// scrape time so the gauge is always fresh and we don't have to
// remember to .set() on every transition.
export const pluginDispatchInFlightGauge = new Gauge({
  name: "karyl_plugin_dispatch_in_flight",
  help: "Concurrent in-flight bot→plugin dispatches per plugin",
  labelNames: ["plugin_id", "shard_id"] as const,
  registers: [metricsRegistry],
  async collect() {
    const snap = await getDispatchPoolSnapshotSafe();
    this.reset();
    for (const entry of snap) {
      this.labels({ plugin_id: entry.pluginKey, shard_id: SHARD_ID }).set(
        entry.inFlight,
      );
    }
  },
});

export const pluginCircuitBreakerOpenGauge = new Gauge({
  name: "karyl_plugin_circuit_breaker_open",
  help: "1 when the per-plugin circuit breaker is open, 0 when closed",
  labelNames: ["plugin_id", "shard_id"] as const,
  registers: [metricsRegistry],
  async collect() {
    const snap = await getDispatchPoolSnapshotSafe();
    this.reset();
    for (const entry of snap) {
      this.labels({ plugin_id: entry.pluginKey, shard_id: SHARD_ID }).set(
        entry.breakerOpen ? 1 : 0,
      );
    }
  },
});

/**
 * Wrapper that defers the actual `getDispatchPoolSnapshot` import to
 * call time so the metrics module loads without pulling the plugin-
 * system tree at boot. The plugin-event-bridge module already imports
 * metrics; importing it back would create a cycle.
 */
async function getDispatchPoolSnapshotSafe(): Promise<
  Array<{ pluginKey: string; inFlight: number; breakerOpen: boolean }>
> {
  try {
    const mod = await import(
      "../plugin-system/plugin-event-bridge.service.js"
    );
    return mod.getDispatchPoolSnapshot();
  } catch {
    return [];
  }
}

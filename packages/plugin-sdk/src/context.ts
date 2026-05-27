/**
 * Runtime context passed to every plugin lifecycle hook
 * (`onStart` / `onStop` / `onEnable` / `onDisable`).
 *
 * Single source of plugin-side platform access:
 *   - `log`         — local pino-shaped logger (goes to the plugin's stdout)
 *   - `botEventLog` — emit a structured entry into the bot's event timeline
 *                     (admin UI's bot-event feed); batched + dedupable
 *   - `metrics`     — counter / gauge / histogram primitives, snapshot
 *                     pushed to the bot every 30 s and on shutdown
 *   - `botRpc`      — escape hatch for any `/api/plugin/*` RPC call
 *   - `manifest`    — the fully-built manifest this plugin registered with
 *
 * Lifecycle hooks receive the same `PluginContext` instance, so a plugin
 * that captures `ctx` inside `onStart` can use it from a background timer
 * or a custom Fastify route without re-plumbing it everywhere.
 */
import type { PluginManifest } from "./manifest.js";
import type { Discord } from "./rpc/discord.js";
import type { Voice } from "./rpc/voice.js";

export interface PluginContext {
  /** Plugin key (matches `PluginConfig.key`). */
  readonly pluginKey: string;
  /** The manifest the bot accepted at register time. */
  readonly manifest: PluginManifest;
  /** Local logger; writes go to the plugin's own stdout. */
  readonly log: PluginLogger;
  /** Emit a structured entry into the bot's event timeline. */
  readonly botEventLog: PluginBotEventLog;
  /** Counter / gauge / histogram primitives. */
  readonly metrics: PluginMetrics;
  /**
   * Call any `/api/plugin/*` RPC endpoint. Resolves with the parsed
   * response body (or `{}` for 204) on success. Throws a `BotRpcError`
   * on failure with `reason: 'no_token' | 'network' | 'http_status'`
   * — wrap in try/catch and discriminate on `reason` to distinguish
   * "bot unreachable" from "bot rejected my request" from "plugin not
   * yet registered".
   *
   * Escape hatch for RPC methods not yet covered by `discord` / `voice`.
   * Prefer the typed namespaces for messages, members, interactions,
   * and voice — they survive future renames / batching / shard-aware
   * routing transparently.
   */
  readonly botRpc: (path: string, body?: unknown) => Promise<unknown>;
  /**
   * Typed Discord RPC facade. `ctx.discord.messages.send({...})`,
   * `ctx.discord.interactions.respond({...})`, etc.
   */
  readonly discord: Discord;
  /** Typed Voice RPC facade. `ctx.voice.play({ guildId, url })`, etc. */
  readonly voice: Voice;
}

// ─── Logger ─────────────────────────────────────────────────────────────

export interface PluginLogger {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

// ─── Bot event log emitter ──────────────────────────────────────────────

export interface PluginBotEventEntry {
  level: "info" | "warn" | "error";
  message: string;
  /** Free-form structured fields attached to the bot event row. */
  context?: Record<string, unknown>;
  /**
   * When set, the bot dedups identical-keyed entries within a 30 s
   * window (mirrors `shouldRecord` in `bot-event-dedup`). Use this for
   * repetitive operational signals — e.g. "downstream API 503" emitted
   * every retry — to avoid flooding the admin UI feed.
   */
  eventKey?: string;
}

export interface PluginBotEventLog {
  /**
   * Fire-and-forget. Entries are buffered in-process and flushed to the
   * bot every 5 s (or earlier when the buffer fills). `info` / `warn` /
   * `error` are persisted; `debug`-shaped local-only logging belongs on
   * `ctx.log`, not here.
   */
  emit(entry: PluginBotEventEntry): void;
}

// ─── Metrics ────────────────────────────────────────────────────────────

export interface PluginMetrics {
  /** Monotonic counter. Reset on plugin restart. */
  counter(name: string, labels?: Record<string, string>): MetricsCounter;
  /** Last-value gauge. */
  gauge(name: string, labels?: Record<string, string>): MetricsGauge;
  /**
   * Histogram tracked via reservoir sampling. The bot stores p50/p95/p99
   * + count + sum from each pushed snapshot (no raw observations).
   */
  histogram(name: string, labels?: Record<string, string>): MetricsHistogram;
}

export interface MetricsCounter {
  inc(n?: number): void;
}

export interface MetricsGauge {
  set(n: number): void;
}

export interface MetricsHistogram {
  observe(n: number): void;
}

// ─── Health ─────────────────────────────────────────────────────────────

export type HealthStatus = "healthy" | "degraded" | "unhealthy";

export interface HealthCheckEntry {
  /** Identifier for this sub-check, e.g. "db", "discord-api", "queue". */
  name: string;
  status: HealthStatus;
  message?: string;
}

export interface HealthReport {
  status: HealthStatus;
  message?: string;
  /** Optional breakdown of dependent-system probes. */
  checks?: HealthCheckEntry[];
  /** Unix ms. SDK fills in `Date.now()` when omitted. */
  checkedAt?: number;
}

/**
 * Producer registered via `PluginConfig.healthCheck`. Called when the
 * bot probes `/health/detail` — typically every 60 s plus on demand
 * from the admin UI. Should complete inside ~2 s; the bot times out at
 * 3 s and labels the plugin `unhealthy` on timeout.
 */
export type HealthProducer = (
  ctx: PluginContext,
) => HealthReport | Promise<HealthReport>;

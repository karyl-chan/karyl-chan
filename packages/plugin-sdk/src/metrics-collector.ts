import type {
  MetricsCounter,
  MetricsGauge,
  MetricsHistogram,
  PluginMetrics,
} from "./context.js";

/**
 * Plugin-side metrics implementation. Holds counters / gauges / histograms
 * in-process and periodically pushes a snapshot to the bot via
 * `POST /api/plugin/metrics.push`. Snapshots are also pushed on shutdown
 * so the last data point reaches the bot before the process exits.
 *
 * No persistence — counters reset on restart. The bot stores only the
 * latest snapshot per plugin in memory; restart-resilience would mean
 * adding a DB table, which the current admin UI doesn't need (it shows
 * current-value tiles, not time series).
 */

const METRIC_NAME_RE = /^[a-z][a-z0-9_.]*$/;
const LABEL_KEY_RE = /^[a-z][a-z0-9_]*$/;

/** Validate a metric or label name; throws on bad input so misuse surfaces at definition time. */
function validateName(name: string, kind: "metric" | "label"): void {
  const re = kind === "metric" ? METRIC_NAME_RE : LABEL_KEY_RE;
  if (typeof name !== "string" || !re.test(name)) {
    throw new Error(
      `metrics: ${kind} name "${String(name)}" must match ${re.source}`,
    );
  }
}

/**
 * Canonical key for `(name, labels)` so two `counter("x", {a:"1",b:"2"})`
 * calls collapse onto the same accumulator regardless of insertion order.
 */
function keyOf(name: string, labels: Record<string, string>): string {
  const entries = Object.entries(labels).sort(([a], [b]) => (a < b ? -1 : 1));
  if (entries.length === 0) return name;
  return `${name}|${entries.map(([k, v]) => `${k}=${v}`).join(",")}`;
}

interface CounterRow {
  name: string;
  labels: Record<string, string>;
  value: number;
}
interface GaugeRow {
  name: string;
  labels: Record<string, string>;
  value: number;
}
interface HistogramSamples {
  name: string;
  labels: Record<string, string>;
  observations: number[];
  count: number;
  sum: number;
}

// p50 / p95 / p99 picks for the snapshot wire format. The plugin
// keeps raw observations between flushes and recomputes quantiles
// at flush time — cheap when the reservoir is bounded.
function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.floor(q * (sorted.length - 1))),
  );
  return sorted[idx];
}

const HISTOGRAM_RESERVOIR_CAP = 1024;
const DEFAULT_FLUSH_INTERVAL_MS = 30_000;

export interface MetricsSnapshot {
  /** Unix ms at snapshot time. */
  ts: number;
  counters: Array<{ name: string; labels: Record<string, string>; value: number }>;
  gauges: Array<{ name: string; labels: Record<string, string>; value: number }>;
  histograms: Array<{
    name: string;
    labels: Record<string, string>;
    count: number;
    sum: number;
    p50: number;
    p95: number;
    p99: number;
  }>;
}

export interface MetricsCollectorOptions {
  /**
   * Push function — the SDK wires this to `callBotRpc` so we don't
   * import server.ts into metrics-collector. Receives the snapshot;
   * returns once the push completes (or fails — caller logs).
   */
  push: (snapshot: MetricsSnapshot) => Promise<void>;
  /** Local logger for warning when flush fails. */
  log: {
    warn(msg: string, context?: Record<string, unknown>): void;
  };
  flushIntervalMs?: number;
}

export class MetricsCollector implements PluginMetrics {
  private readonly counters = new Map<string, CounterRow>();
  private readonly gauges = new Map<string, GaugeRow>();
  private readonly histograms = new Map<string, HistogramSamples>();
  private flushTimer: NodeJS.Timeout | null = null;
  private readonly intervalMs: number;
  private stopped = false;

  constructor(private readonly opts: MetricsCollectorOptions) {
    this.intervalMs = opts.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
  }

  counter(name: string, labels: Record<string, string> = {}): MetricsCounter {
    validateName(name, "metric");
    for (const k of Object.keys(labels)) validateName(k, "label");
    const k = keyOf(name, labels);
    let row = this.counters.get(k);
    if (!row) {
      row = { name, labels: { ...labels }, value: 0 };
      this.counters.set(k, row);
    }
    return {
      inc: (n = 1) => {
        if (!Number.isFinite(n)) return;
        row!.value += n;
      },
    };
  }

  gauge(name: string, labels: Record<string, string> = {}): MetricsGauge {
    validateName(name, "metric");
    for (const k of Object.keys(labels)) validateName(k, "label");
    const k = keyOf(name, labels);
    let row = this.gauges.get(k);
    if (!row) {
      row = { name, labels: { ...labels }, value: 0 };
      this.gauges.set(k, row);
    }
    return {
      set: (n: number) => {
        if (!Number.isFinite(n)) return;
        row!.value = n;
      },
    };
  }

  histogram(
    name: string,
    labels: Record<string, string> = {},
  ): MetricsHistogram {
    validateName(name, "metric");
    for (const k of Object.keys(labels)) validateName(k, "label");
    const k = keyOf(name, labels);
    let row = this.histograms.get(k);
    if (!row) {
      row = {
        name,
        labels: { ...labels },
        observations: [],
        count: 0,
        sum: 0,
      };
      this.histograms.set(k, row);
    }
    return {
      observe: (n: number) => {
        if (!Number.isFinite(n)) return;
        row!.count += 1;
        row!.sum += n;
        // Reservoir cap — once we hit the ceiling we replace a random
        // slot so the sample distribution stays representative without
        // unbounded growth between flushes.
        if (row!.observations.length < HISTOGRAM_RESERVOIR_CAP) {
          row!.observations.push(n);
        } else {
          const slot = Math.floor(Math.random() * row!.count);
          if (slot < HISTOGRAM_RESERVOIR_CAP) {
            row!.observations[slot] = n;
          }
        }
      },
    };
  }

  /**
   * Build a snapshot of current state.
   *
   * Histograms keep their reservoir across snapshots — the reservoir
   * IS the bounded uniform sample of all observations since the plugin
   * started, and count/sum are cumulative. Earlier versions drained
   * the reservoir per snapshot, which produced `p50=p95=p99=0` for
   * idle intervals (no observations since last push) — admin UI then
   * rendered "0ms median" for a healthy-but-idle plugin. Keeping the
   * reservoir matches what count/sum already represent (lifetime
   * cumulative) and avoids the misleading-zeros mode.
   */
  snapshot(): MetricsSnapshot {
    const snapshot: MetricsSnapshot = {
      ts: Date.now(),
      counters: [...this.counters.values()].map((c) => ({
        name: c.name,
        labels: c.labels,
        value: c.value,
      })),
      gauges: [...this.gauges.values()].map((g) => ({
        name: g.name,
        labels: g.labels,
        value: g.value,
      })),
      histograms: [...this.histograms.values()].map((h) => {
        const sorted = [...h.observations].sort((a, b) => a - b);
        return {
          name: h.name,
          labels: h.labels,
          count: h.count,
          sum: h.sum,
          p50: quantile(sorted, 0.5),
          p95: quantile(sorted, 0.95),
          p99: quantile(sorted, 0.99),
        };
      }),
    };
    return snapshot;
  }

  /** Start the periodic flush. Safe to call multiple times — second call is a no-op. */
  start(): void {
    if (this.flushTimer) return;
    this.flushTimer = setInterval(() => {
      void this.flushNow();
    }, this.intervalMs);
    // unref so the timer doesn't keep the event loop alive past shutdown.
    if (typeof this.flushTimer.unref === "function") this.flushTimer.unref();
  }

  /** Stop the periodic flush. Calls `flushNow()` once before stopping. */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flushNow();
  }

  async flushNow(): Promise<void> {
    const snap = this.snapshot();
    if (
      snap.counters.length === 0 &&
      snap.gauges.length === 0 &&
      snap.histograms.length === 0
    ) {
      return;
    }
    try {
      await this.opts.push(snap);
    } catch (err) {
      this.opts.log.warn("metrics flush failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

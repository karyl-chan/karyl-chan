/**
 * PluginMetricsStore — latest snapshot per plugin.
 *
 * Plugins push a `MetricsCollector` snapshot every 30 s; admin UI
 * reads the latest. Bounded by FRESHNESS_TTL — older snapshots are
 * dropped on read so an offline plugin doesn't render stale numbers.
 *
 * InProcess default keeps the snapshots in a `Map<pluginKey, …>` (the
 * pre-Phase-0 behaviour). Phase 1.3 of SCALING_PLAN swaps in a Redis
 * hash so the admin UI on shard B can read snapshots a plugin pushed
 * to shard A.
 */

export interface StoredMetricsSnapshot {
  ts: number;
  counters: Array<{
    name: string;
    labels: Record<string, string>;
    value: number;
  }>;
  gauges: Array<{
    name: string;
    labels: Record<string, string>;
    value: number;
  }>;
  histograms: Array<{
    name: string;
    labels: Record<string, string>;
    count: number;
    sum: number;
    p50: number;
    p95: number;
    p99: number;
  }>;
  /** Wall-clock receipt time (server side). */
  receivedAt: number;
}

export interface PluginMetricsStore {
  setSnapshot(
    pluginKey: string,
    snapshot: Omit<StoredMetricsSnapshot, "receivedAt">,
  ): void;
  getSnapshot(pluginKey: string): StoredMetricsSnapshot | null;
  clearSnapshot(pluginKey: string): void;
}

const FRESHNESS_TTL_MS = 5 * 60 * 1000;

export class InProcessPluginMetricsStore implements PluginMetricsStore {
  private readonly store = new Map<string, StoredMetricsSnapshot>();

  setSnapshot(
    pluginKey: string,
    snapshot: Omit<StoredMetricsSnapshot, "receivedAt">,
  ): void {
    this.store.set(pluginKey, { ...snapshot, receivedAt: Date.now() });
  }

  getSnapshot(pluginKey: string): StoredMetricsSnapshot | null {
    const s = this.store.get(pluginKey);
    if (!s) return null;
    if (Date.now() - s.receivedAt > FRESHNESS_TTL_MS) {
      this.store.delete(pluginKey);
      return null;
    }
    return s;
  }

  clearSnapshot(pluginKey: string): void {
    this.store.delete(pluginKey);
  }
}

/**
 * In-memory store for plugin-pushed metrics snapshots.
 *
 * Each active plugin pushes a snapshot via `POST /api/plugin/metrics.push`
 * every 30 s. The bot keeps only the latest snapshot per plugin — restart-
 * resilience is unnecessary because plugins re-push within a snapshot
 * interval after the bot comes back up.
 *
 * The shape mirrors the wire format from `MetricsCollector.snapshot()` on
 * the SDK side; we accept the JSON verbatim and store it. Schema drift
 * would surface in the admin UI rendering, not in storage.
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

const store = new Map<string, StoredMetricsSnapshot>();

/** Cap on how stale a snapshot can be before it's evicted on read. */
const FRESHNESS_TTL_MS = 5 * 60 * 1000;

export function setSnapshot(
  pluginKey: string,
  snapshot: Omit<StoredMetricsSnapshot, "receivedAt">,
): void {
  store.set(pluginKey, { ...snapshot, receivedAt: Date.now() });
}

export function getSnapshot(pluginKey: string): StoredMetricsSnapshot | null {
  const s = store.get(pluginKey);
  if (!s) return null;
  // A plugin that's been offline > TTL — drop the cached snapshot so
  // the admin UI doesn't render stale numbers as live.
  if (Date.now() - s.receivedAt > FRESHNESS_TTL_MS) {
    store.delete(pluginKey);
    return null;
  }
  return s;
}

export function clearSnapshot(pluginKey: string): void {
  store.delete(pluginKey);
}

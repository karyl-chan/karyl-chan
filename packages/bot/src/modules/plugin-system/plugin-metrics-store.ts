/**
 * Plugin metrics store — thin re-export over the adapter registry.
 *
 * The interface is async so a Redis-backed implementation can be
 * hot-swapped. Sync callers (admin UI handler in plugin-routes)
 * already run inside async handlers; the only change is one `await`.
 *
 * Swap implementation: `PLUGIN_METRICS_STORE=redis` + `REDIS_URL=...`.
 */

import { getPluginMetricsStore } from "../../adapters/registry.js";
import type { StoredMetricsSnapshot } from "../../adapters/plugin-metrics-store.js";

export type { StoredMetricsSnapshot } from "../../adapters/plugin-metrics-store.js";

export async function setSnapshot(
  pluginKey: string,
  snapshot: Omit<StoredMetricsSnapshot, "receivedAt">,
): Promise<void> {
  await getPluginMetricsStore().setSnapshot(pluginKey, snapshot);
}

export async function getSnapshot(
  pluginKey: string,
): Promise<StoredMetricsSnapshot | null> {
  return getPluginMetricsStore().getSnapshot(pluginKey);
}

export async function clearSnapshot(pluginKey: string): Promise<void> {
  await getPluginMetricsStore().clearSnapshot(pluginKey);
}

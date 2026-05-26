/**
 * Plugin metrics store — thin re-export over the adapter registry.
 *
 * The actual implementation lives in `src/adapters/plugin-metrics-store.ts`
 * (interface + `InProcessPluginMetricsStore`). This module preserves the
 * pre-Phase-0.2 import surface (`setSnapshot` / `getSnapshot` /
 * `clearSnapshot` as free functions) so existing call sites don't have
 * to chase the refactor — they delegate to the registry-resolved store.
 *
 * To swap the implementation (Phase 1.3): set `PLUGIN_METRICS_STORE`
 * env var; nothing else changes.
 */

import { getPluginMetricsStore } from "../../adapters/registry.js";
import type { StoredMetricsSnapshot } from "../../adapters/plugin-metrics-store.js";

export type { StoredMetricsSnapshot } from "../../adapters/plugin-metrics-store.js";

export function setSnapshot(
  pluginKey: string,
  snapshot: Omit<StoredMetricsSnapshot, "receivedAt">,
): void {
  getPluginMetricsStore().setSnapshot(pluginKey, snapshot);
}

export function getSnapshot(pluginKey: string): StoredMetricsSnapshot | null {
  return getPluginMetricsStore().getSnapshot(pluginKey);
}

export function clearSnapshot(pluginKey: string): void {
  getPluginMetricsStore().clearSnapshot(pluginKey);
}

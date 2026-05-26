/**
 * Plugin health store — thin re-export over the adapter registry.
 *
 * Mirror of `plugin-metrics-store.ts`. The interface +
 * `InProcessPluginHealthStore` live in
 * `src/adapters/plugin-health-store.ts`; this module keeps the
 * pre-Phase-0.2 free-function surface so callers don't have to know
 * about the registry.
 *
 * Swap implementation (Phase 1.3): set `PLUGIN_HEALTH_STORE` env var.
 */

import { getPluginHealthStore } from "../../adapters/registry.js";
import type {
  StoredHealthEntry,
  HealthStatus,
} from "../../adapters/plugin-health-store.js";

export type {
  HealthStatus,
  StoredHealthEntry,
} from "../../adapters/plugin-health-store.js";

export function setHealth(
  pluginKey: string,
  entry: Omit<StoredHealthEntry, "receivedAt">,
): void {
  getPluginHealthStore().setHealth(pluginKey, entry);
}

export function getHealth(pluginKey: string): StoredHealthEntry | null {
  return getPluginHealthStore().getHealth(pluginKey);
}

export function clearHealth(pluginKey: string): void {
  getPluginHealthStore().clearHealth(pluginKey);
}

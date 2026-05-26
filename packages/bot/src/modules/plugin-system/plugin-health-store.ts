/**
 * Plugin health store — thin re-export over the adapter registry.
 *
 * Mirror of `plugin-metrics-store.ts`. Phase 1.3 widened the
 * interface to async so a Redis-backed implementation can plug in
 * uniformly; sync callers (health poller) already run inside async
 * functions.
 *
 * Swap implementation: `PLUGIN_HEALTH_STORE=redis`.
 */

import { getPluginHealthStore } from "../../adapters/registry.js";
import type {
  StoredHealthEntry,
} from "../../adapters/plugin-health-store.js";

export type {
  HealthStatus,
  StoredHealthEntry,
} from "../../adapters/plugin-health-store.js";

export async function setHealth(
  pluginKey: string,
  entry: Omit<StoredHealthEntry, "receivedAt">,
): Promise<void> {
  await getPluginHealthStore().setHealth(pluginKey, entry);
}

export async function getHealth(
  pluginKey: string,
): Promise<StoredHealthEntry | null> {
  return getPluginHealthStore().getHealth(pluginKey);
}

export async function clearHealth(pluginKey: string): Promise<void> {
  await getPluginHealthStore().clearHealth(pluginKey);
}

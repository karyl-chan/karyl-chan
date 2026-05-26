/**
 * PluginHealthStore — latest health-probe result per plugin.
 *
 * The plugin-health-poller hits each plugin's `/health/detail` every
 * 60 s; results land here. Bounded by FRESHNESS_TTL so a plugin going
 * silent isn't shown as "healthy" indefinitely.
 *
 * Same Phase 1.3 swap target as PluginMetricsStore — Redis hash so
 * the admin UI sees the same picture from any shard.
 */

export type HealthStatus = "healthy" | "degraded" | "unhealthy";

export interface StoredHealthEntry {
  status: HealthStatus;
  message?: string;
  checks?: Array<{ name: string; status: HealthStatus; message?: string }>;
  /** Plugin-reported timestamp from the response. */
  checkedAt: number;
  /** Wall-clock receipt time. */
  receivedAt: number;
  /** True when the result is the poller's record of failure (timeout / network). */
  fromError?: boolean;
}

export interface PluginHealthStore {
  setHealth(
    pluginKey: string,
    entry: Omit<StoredHealthEntry, "receivedAt">,
  ): void | Promise<void>;
  getHealth(
    pluginKey: string,
  ): StoredHealthEntry | null | Promise<StoredHealthEntry | null>;
  clearHealth(pluginKey: string): void | Promise<void>;
}

const FRESHNESS_TTL_MS = 5 * 60 * 1000;

export class InProcessPluginHealthStore implements PluginHealthStore {
  private readonly store = new Map<string, StoredHealthEntry>();

  setHealth(
    pluginKey: string,
    entry: Omit<StoredHealthEntry, "receivedAt">,
  ): void {
    this.store.set(pluginKey, { ...entry, receivedAt: Date.now() });
  }

  getHealth(pluginKey: string): StoredHealthEntry | null {
    const e = this.store.get(pluginKey);
    if (!e) return null;
    if (Date.now() - e.receivedAt > FRESHNESS_TTL_MS) {
      this.store.delete(pluginKey);
      return null;
    }
    return e;
  }

  clearHealth(pluginKey: string): void {
    this.store.delete(pluginKey);
  }
}

/**
 * In-memory store for plugin health probe results.
 *
 * Populated by `plugin-health-poller.service.ts` (background poll every
 * 60 s) and read by the admin UI. Like `plugin-metrics-store`, this is
 * not persisted — on bot restart, the poller re-populates within a
 * polling cycle. Entries older than the freshness TTL are treated as
 * absent on read so a plugin going offline doesn't keep showing the
 * last-known-good status forever.
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

const store = new Map<string, StoredHealthEntry>();

/** Older than this and a read treats the cache as cold. */
const FRESHNESS_TTL_MS = 5 * 60 * 1000;

export function setHealth(
  pluginKey: string,
  entry: Omit<StoredHealthEntry, "receivedAt">,
): void {
  store.set(pluginKey, { ...entry, receivedAt: Date.now() });
}

export function getHealth(pluginKey: string): StoredHealthEntry | null {
  const e = store.get(pluginKey);
  if (!e) return null;
  if (Date.now() - e.receivedAt > FRESHNESS_TTL_MS) {
    store.delete(pluginKey);
    return null;
  }
  return e;
}

export function clearHealth(pluginKey: string): void {
  store.delete(pluginKey);
}

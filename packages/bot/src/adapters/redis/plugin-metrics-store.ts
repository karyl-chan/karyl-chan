/**
 * Redis-backed PluginMetricsStore.
 *
 * One key per plugin: `karyl:plugin:metrics:<pluginKey>` → JSON
 * snapshot. PX TTL set to the in-memory FRESHNESS_TTL so an offline
 * plugin's snapshot evicts itself automatically.
 */

import {
  type PluginMetricsStore,
  type StoredMetricsSnapshot,
} from "../plugin-metrics-store.js";
import { getRedisClient, type RedisLike } from "./client.js";

const FRESHNESS_TTL_MS = 5 * 60 * 1000;
const PREFIX = "karyl:plugin:metrics:";
const key = (pluginKey: string) => `${PREFIX}${pluginKey}`;

export class RedisPluginMetricsStore implements PluginMetricsStore {
  constructor(private readonly redis: RedisLike = getRedisClient()) {}

  async setSnapshot(
    pluginKey: string,
    snapshot: Omit<StoredMetricsSnapshot, "receivedAt">,
  ): Promise<void> {
    const value: StoredMetricsSnapshot = {
      ...snapshot,
      receivedAt: Date.now(),
    };
    await this.redis.set(
      key(pluginKey),
      JSON.stringify(value),
      "PX",
      FRESHNESS_TTL_MS,
    );
  }

  async getSnapshot(
    pluginKey: string,
  ): Promise<StoredMetricsSnapshot | null> {
    const raw = await this.redis.get(key(pluginKey));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as StoredMetricsSnapshot;
    } catch {
      // Corrupt JSON — evict and miss.
      await this.redis.del(key(pluginKey));
      return null;
    }
  }

  async clearSnapshot(pluginKey: string): Promise<void> {
    await this.redis.del(key(pluginKey));
  }
}

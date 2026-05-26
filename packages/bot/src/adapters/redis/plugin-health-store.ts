/**
 * Redis-backed PluginHealthStore — Phase 1.3. Mirror of
 * `redis/plugin-metrics-store.ts`.
 */

import {
  type PluginHealthStore,
  type StoredHealthEntry,
} from "../plugin-health-store.js";
import { getRedisClient, type RedisLike } from "./client.js";

const FRESHNESS_TTL_MS = 5 * 60 * 1000;
const PREFIX = "karyl:plugin:health:";
const key = (pluginKey: string) => `${PREFIX}${pluginKey}`;

export class RedisPluginHealthStore implements PluginHealthStore {
  constructor(private readonly redis: RedisLike = getRedisClient()) {}

  async setHealth(
    pluginKey: string,
    entry: Omit<StoredHealthEntry, "receivedAt">,
  ): Promise<void> {
    const value: StoredHealthEntry = { ...entry, receivedAt: Date.now() };
    await this.redis.set(
      key(pluginKey),
      JSON.stringify(value),
      "PX",
      FRESHNESS_TTL_MS,
    );
  }

  async getHealth(pluginKey: string): Promise<StoredHealthEntry | null> {
    const raw = await this.redis.get(key(pluginKey));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as StoredHealthEntry;
    } catch {
      await this.redis.del(key(pluginKey));
      return null;
    }
  }

  async clearHealth(pluginKey: string): Promise<void> {
    await this.redis.del(key(pluginKey));
  }
}

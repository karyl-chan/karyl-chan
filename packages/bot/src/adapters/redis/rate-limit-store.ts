/**
 * Redis-backed RateLimitStoreFactory — Phase 1.2.
 *
 * `@fastify/rate-limit` accepts a `redis: <ioredis-like-client>`
 * option. With it, every limit counter lives in Redis instead of
 * per-process memory, so a 2-shard deployment can enforce a single
 * shared budget. Without it, each shard counts independently and
 * the effective limit doubles per shard.
 *
 * This factory returns the shared client from `redis/client.ts` so
 * the rate limiter shares its connection with SessionStore /
 * DistributedLock / etc.
 */

import {
  type RateLimitStoreFactory,
} from "../rate-limit-store.js";
import { getRedisClient } from "./client.js";

export class RedisRateLimitStoreFactory implements RateLimitStoreFactory {
  redisClient(): unknown {
    return getRedisClient();
  }
}

/**
 * RedisRateLimitStoreFactory smoke test.
 *
 * The factory just hands the shared Redis client back to whoever
 * configures a rate limiter. Production: pass through to a Redis-
 * backed sliding-window counter. The in-memory bot-wide `RateLimiter`
 * utility class is NOT swapped here — that's a sync→async refactor
 * of every rate-limited route, tracked separately.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  setRedisClientForTests,
  __resetRedisClientForTests,
  type RedisLike,
} from "../src/adapters/redis/client.js";
import { RedisRateLimitStoreFactory } from "../src/adapters/redis/rate-limit-store.js";
import { InProcessRateLimitStoreFactory } from "../src/adapters/rate-limit-store.js";

function dummy(): RedisLike {
  return {
    get: async () => null,
    set: async () => "OK",
    del: async () => 0,
    hset: async () => 0,
    hget: async () => null,
    hdel: async () => 0,
    hgetall: async () => ({}),
    expire: async () => 0,
    pexpire: async () => 0,
    pttl: async () => -1,
    eval: async () => null,
    scan: async () => ["0", []],
    ping: async () => "PONG",
    quit: async () => "OK",
  };
}

beforeEach(() => {
  setRedisClientForTests(dummy());
});
afterEach(() => {
  setRedisClientForTests(null);
  __resetRedisClientForTests();
});

describe("RateLimitStoreFactory implementations", () => {
  it("InProcess returns null (uses library default)", () => {
    expect(new InProcessRateLimitStoreFactory().redisClient()).toBeNull();
  });

  it("Redis factory returns the shared client", () => {
    const c = new RedisRateLimitStoreFactory().redisClient();
    expect(c).not.toBeNull();
    expect(typeof (c as RedisLike).ping).toBe("function");
  });
});

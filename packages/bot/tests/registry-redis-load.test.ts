import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __resetAdaptersForTests,
  getDistributedLock,
  getPluginEventBus,
  getPluginHealthStore,
  getPluginMetricsStore,
  getRateLimitStoreFactory,
  getSessionStore,
} from "../src/adapters/registry.js";
import {
  __resetRedisClientForTests,
  setRedisClientForTests,
  type RedisLike,
} from "../src/adapters/redis/client.js";

// Regression: the registry used `require(...)` to lazy-load Redis impls,
// which crashes under ESM (ReferenceError: require is not defined).
// Static imports keep every "redis" branch instantiable.

const stub: RedisLike = {
  get: async () => null,
  set: async () => "OK",
  del: async () => 0,
  hset: async () => 0,
  hget: async () => null,
  hdel: async () => 0,
  hgetall: async () => ({}),
  expire: async () => 1,
  pexpire: async () => 1,
  pttl: async () => -1,
  eval: async () => null,
  scan: async () => ["0", []],
  ping: async () => "PONG",
  quit: async () => "OK",
};

const RESET = (): void => {
  __resetAdaptersForTests();
  __resetRedisClientForTests();
  delete process.env.PLUGIN_METRICS_STORE;
  delete process.env.PLUGIN_HEALTH_STORE;
  delete process.env.DISTRIBUTED_LOCK;
  delete process.env.RATE_LIMIT_STORE;
  delete process.env.SESSION_STORE;
  delete process.env.EVENT_BUS;
};

describe("adapter registry — Redis branches load under ESM", () => {
  beforeEach(() => {
    setRedisClientForTests(stub);
  });
  afterEach(RESET);

  it("getPluginMetricsStore with PLUGIN_METRICS_STORE=redis instantiates", () => {
    process.env.PLUGIN_METRICS_STORE = "redis";
    expect(() => getPluginMetricsStore()).not.toThrow();
  });

  it("getPluginHealthStore with PLUGIN_HEALTH_STORE=redis instantiates", () => {
    process.env.PLUGIN_HEALTH_STORE = "redis";
    expect(() => getPluginHealthStore()).not.toThrow();
  });

  it("getDistributedLock with DISTRIBUTED_LOCK=redis instantiates", () => {
    process.env.DISTRIBUTED_LOCK = "redis";
    expect(() => getDistributedLock()).not.toThrow();
  });

  it("getRateLimitStoreFactory with RATE_LIMIT_STORE=redis instantiates", () => {
    process.env.RATE_LIMIT_STORE = "redis";
    expect(() => getRateLimitStoreFactory()).not.toThrow();
  });

  it("getSessionStore with SESSION_STORE=redis instantiates", () => {
    process.env.SESSION_STORE = "redis";
    expect(() => getSessionStore()).not.toThrow();
  });

  it("getPluginEventBus with EVENT_BUS=redis-streams instantiates", () => {
    process.env.EVENT_BUS = "redis-streams";
    expect(() => getPluginEventBus()).not.toThrow();
  });
});

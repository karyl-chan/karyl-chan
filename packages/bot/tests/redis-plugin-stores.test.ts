/**
 * Redis-backed PluginMetricsStore + PluginHealthStore against the
 * in-memory RedisLike stub from redis-session-store test.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  setRedisClientForTests,
  __resetRedisClientForTests,
  type RedisLike,
} from "../src/adapters/redis/client.js";
import { RedisPluginMetricsStore } from "../src/adapters/redis/plugin-metrics-store.js";
import { RedisPluginHealthStore } from "../src/adapters/redis/plugin-health-store.js";

function makeStub(): RedisLike {
  const data = new Map<string, string>();
  return {
    async get(key) {
      return data.get(key) ?? null;
    },
    async set(key, value) {
      data.set(key, value);
      return "OK";
    },
    async del(...keys) {
      let n = 0;
      for (const k of keys) {
        if (data.delete(k)) n++;
      }
      return n;
    },
    async hset() {
      return 0;
    },
    async hget() {
      return null;
    },
    async hdel() {
      return 0;
    },
    async hgetall() {
      return {};
    },
    async expire() {
      return 0;
    },
    async pexpire() {
      return 0;
    },
    async pttl() {
      return -1;
    },
    async eval() {
      return null;
    },
    async scan() {
      return ["0", []];
    },
    async ping() {
      return "PONG";
    },
    async quit() {
      return "OK";
    },
  };
}

beforeEach(() => {
  setRedisClientForTests(makeStub());
});
afterEach(() => {
  setRedisClientForTests(null);
  __resetRedisClientForTests();
});

describe("RedisPluginMetricsStore", () => {
  const emptySnap = { ts: 0, counters: [], gauges: [], histograms: [] };
  it("round-trips a snapshot, stamps receivedAt", async () => {
    const s = new RedisPluginMetricsStore();
    await s.setSnapshot("p1", emptySnap);
    const out = await s.getSnapshot("p1");
    expect(out).toMatchObject({ ts: 0 });
    expect(out?.receivedAt).toBeGreaterThan(0);
  });
  it("returns null for unknown plugin", async () => {
    const s = new RedisPluginMetricsStore();
    expect(await s.getSnapshot("ghost")).toBeNull();
  });
  it("clearSnapshot drops the entry", async () => {
    const s = new RedisPluginMetricsStore();
    await s.setSnapshot("p1", emptySnap);
    await s.clearSnapshot("p1");
    expect(await s.getSnapshot("p1")).toBeNull();
  });
});

describe("RedisPluginHealthStore", () => {
  const healthy = { status: "healthy" as const, checkedAt: 0 };
  it("round-trips a health entry", async () => {
    const s = new RedisPluginHealthStore();
    await s.setHealth("p1", healthy);
    const out = await s.getHealth("p1");
    expect(out?.status).toBe("healthy");
    expect(out?.receivedAt).toBeGreaterThan(0);
  });
  it("clearHealth removes the entry", async () => {
    const s = new RedisPluginHealthStore();
    await s.setHealth("p1", healthy);
    await s.clearHealth("p1");
    expect(await s.getHealth("p1")).toBeNull();
  });
});

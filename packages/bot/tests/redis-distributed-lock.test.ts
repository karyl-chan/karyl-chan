/**
 * Phase 1.4 — Redis DistributedLock against an in-memory RedisLike
 * stub. The stub honours NX, PX, and the Lua "del if value matches"
 * release script enough that the lock's exclusion + auto-expiry
 * behaviour is exercised end-to-end.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  setRedisClientForTests,
  __resetRedisClientForTests,
  type RedisLike,
} from "../src/adapters/redis/client.js";
import { RedisDistributedLock } from "../src/adapters/redis/distributed-lock.js";

interface StoredVal {
  value: string;
  expiresAt: number | null;
}

function makeStub(): RedisLike {
  const data = new Map<string, StoredVal>();
  const now = () => Date.now();
  function isAlive(k: string): boolean {
    const v = data.get(k);
    if (!v) return false;
    if (v.expiresAt !== null && v.expiresAt <= now()) {
      data.delete(k);
      return false;
    }
    return true;
  }
  return {
    async get(key) {
      return isAlive(key) ? data.get(key)!.value : null;
    },
    async set(key, value, ...args) {
      let nx = false;
      let expiresAt: number | null = null;
      for (let i = 0; i < args.length; i++) {
        if (args[i] === "NX") nx = true;
        if (args[i] === "PX" && typeof args[i + 1] === "number") {
          expiresAt = now() + (args[i + 1] as number);
        }
      }
      if (nx && isAlive(key)) return null;
      data.set(key, { value: String(value), expiresAt });
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
    async eval(_script, _numKeys, ...args) {
      // Implement the release script: KEYS[1]=key, ARGV[1]=owner.
      const key = String(args[0]);
      const owner = String(args[1]);
      const cur = isAlive(key) ? data.get(key)!.value : null;
      if (cur === owner) {
        data.delete(key);
        return 1;
      }
      return 0;
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

describe("RedisDistributedLock", () => {
  it("runs fn under exclusive lock, releases on success", async () => {
    const lock = new RedisDistributedLock();
    const result = await lock.run("global-reconcile", async () => "ok");
    expect(result).toBe("ok");
  });

  it("two concurrent acquires on the same key serialise", async () => {
    const lock = new RedisDistributedLock();
    let inFlight = 0;
    let peak = 0;
    const task = () =>
      lock.run("k", async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 20));
        inFlight--;
      });
    await Promise.all([task(), task(), task()]);
    expect(peak).toBe(1);
  });

  it("releases on throw, doesn't deadlock the next holder", async () => {
    const lock = new RedisDistributedLock();
    await expect(
      lock.run("k", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    const r = await lock.run("k", async () => "after");
    expect(r).toBe("after");
  });

  it("honours timeoutMs and rejects when blocked", async () => {
    const lock = new RedisDistributedLock();
    // Hold the lock from one task with a slow fn; another tries to
    // acquire with a tiny timeout and fails.
    const slow = lock.run("k", () => new Promise((r) => setTimeout(r, 200)));
    await expect(
      lock.run("k", async () => "never", { timeoutMs: 30 }),
    ).rejects.toThrow(/timed out/);
    await slow;
  });

  it("isLeader returns true (conservative)", async () => {
    const lock = new RedisDistributedLock();
    expect(await lock.isLeader("anything")).toBe(true);
  });
});

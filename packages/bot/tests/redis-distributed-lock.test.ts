/**
 * Redis DistributedLock against an in-memory RedisLike stub. The stub
 * honours NX, PX, and the Lua "del if value matches" release script
 * enough that the lock's exclusion + auto-expiry behaviour is
 * exercised end-to-end.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  vi.useRealTimers();
  vi.restoreAllMocks();
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

  it("does not acquire after deadline even if holder releases mid-wait", async () => {
    // Regression: the previous polling loop checked the deadline
    // AFTER each SET attempt. When the holder released the key
    // during a polling sleep that outran the caller's timeoutMs
    // (jitterDelay 50–500 ms vs timeoutMs 30 ms), the next iteration
    // would silently acquire the now-free lock past the deadline,
    // running fn even though the caller asked us to give up.
    //
    // Hold for 100 ms; with timeoutMs 30 ms the second `run` MUST
    // reject at the deadline, BEFORE the holder releases. Fake timers
    // make this an ordering check on virtual time instead of a
    // wall-clock bound (which flaked under full-suite load, #237).
    // Math.random is pinned so jitterDelay lands at its 495 ms
    // ceiling: the pre-fix loop then always sleeps past the holder's
    // release and steals the lock, rather than only sometimes.
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.99);
    const lock = new RedisDistributedLock();
    const events: string[] = [];
    const slow = lock
      .run("k", () => new Promise((r) => setTimeout(r, 100)))
      .then(() => events.push("holder released"));
    const waiter = lock
      .run(
        "k",
        async () => {
          events.push("waiter acquired");
          return "stolen";
        },
        { timeoutMs: 30 },
      )
      .then(
        () => events.push("waiter resolved"),
        (err: Error) => events.push(`waiter rejected: ${err.message}`),
      );

    await vi.advanceTimersByTimeAsync(30);
    expect(events).toEqual(["waiter rejected: lock 'k' acquire timed out"]);

    await vi.advanceTimersByTimeAsync(1_000);
    await Promise.all([waiter, slow]);
    expect(events).toEqual([
      "waiter rejected: lock 'k' acquire timed out",
      "holder released",
    ]);
  });

  it("does not acquire at the deadline even if holder released before it", async () => {
    // The other half of the same fix: the deadline is checked BEFORE
    // each SET. The waiter's first SET fails against the holder, then
    // its sleep is capped at the remaining budget, so it wakes exactly
    // at the deadline. The holder released at 20 ms, so a SET at that
    // point would succeed and run fn after the caller's timeout. The
    // pre-SET check must reject instead.
    vi.useFakeTimers();
    const lock = new RedisDistributedLock();
    const events: string[] = [];
    const holder = lock
      .run("k", () => new Promise((r) => setTimeout(r, 20)))
      .then(() => events.push("holder released"));
    const waiter = lock
      .run(
        "k",
        async () => {
          events.push("waiter acquired");
          return "late";
        },
        { timeoutMs: 30 },
      )
      .then(
        () => events.push("waiter resolved"),
        (err: Error) => events.push(`waiter rejected: ${err.message}`),
      );

    await vi.advanceTimersByTimeAsync(30);
    await Promise.all([waiter, holder]);
    expect(events).toEqual([
      "holder released",
      "waiter rejected: lock 'k' acquire timed out",
    ]);
  });

  it("isLeader elects the first claimant per key", async () => {
    const stub = makeStub();
    const a = new RedisDistributedLock(stub, "shard:A");
    const b = new RedisDistributedLock(stub, "shard:B");
    // A claims first → leader. B is then locked out for the TTL.
    expect(await a.isLeader("daily-cleanup")).toBe(true);
    expect(await b.isLeader("daily-cleanup")).toBe(false);
    // A polling again refreshes its lease and stays leader.
    expect(await a.isLeader("daily-cleanup")).toBe(true);
    // Different keys are independent.
    expect(await b.isLeader("other-task")).toBe(true);
    expect(await a.isLeader("other-task")).toBe(false);
  });

  it("transient SET rejection retries instead of escaping", async () => {
    // Simulate a Redis network blip: the first SET rejects, the
    // second succeeds. The lock should treat the rejection as
    // "not acquired" and retry, not surface it as unhandled.
    let attempts = 0;
    const flaky = makeStub();
    const realSet = flaky.set.bind(flaky);
    flaky.set = (async (...args: Parameters<typeof realSet>) => {
      attempts++;
      if (attempts === 1) throw new Error("ETIMEDOUT");
      return realSet(...args);
    }) as typeof flaky.set;
    setRedisClientForTests(flaky);
    const lock = new RedisDistributedLock(flaky);
    const r = await lock.run("k", async () => "ok");
    expect(r).toBe("ok");
    expect(attempts).toBeGreaterThanOrEqual(2);
  });

  it("repeated SET rejections still respect timeoutMs", async () => {
    const stub = makeStub();
    stub.set = (async () => {
      throw new Error("ECONNRESET");
    }) as typeof stub.set;
    const lock = new RedisDistributedLock(stub);
    await expect(
      lock.run("k", async () => "never", { timeoutMs: 50 }),
    ).rejects.toThrow(/timed out/);
  });
});

/**
 * Redis-backed DistributedLock.
 *
 * Uses Redis SETNX + PX TTL for atomic acquisition, plus an owner-
 * tagged Lua release script so only the holder can delete the key.
 * Multi-shard deployments use this to serialise global tasks
 * (global slash-command reconcile, DB migrations, scheduled jobs)
 * across processes.
 *
 *   Acquire:  SET karyl:lock:<key> <ownerToken> NX PX <ttlMs>
 *   Release:  Lua { if get == ownerToken then del }
 *
 * No watchdog renewal yet — `run(fn)` callers should keep fn's
 * runtime below `lockTtlMs` (default 60 s). If a fn might legitimately
 * exceed that, pass a larger `timeoutMs` and we'll tune the TTL
 * to match.
 *
 * Polling acquire: backs off 50→500 ms with jitter to avoid lock-
 * stampede when N shards all start at the same time.
 */

import { randomBytes } from "crypto";
import { config } from "../../config.js";
import type { DistributedLock } from "../distributed-lock.js";
import { getRedisClient, type RedisLike } from "./client.js";

const PREFIX = "karyl:lock:";
const LEADER_PREFIX = "karyl:leader:";
const lockKey = (key: string) => `${PREFIX}${key}`;
const leaderKey = (key: string) => `${LEADER_PREFIX}${key}`;
const DEFAULT_LOCK_TTL_MS = 60_000;
const LEADER_TTL_MS = 30_000;
const ACQUIRE_POLL_MIN_MS = 50;
const ACQUIRE_POLL_MAX_MS = 500;

const RELEASE_SCRIPT =
  `if redis.call("get", KEYS[1]) == ARGV[1] then ` +
  `return redis.call("del", KEYS[1]) else return 0 end`;

function jitterDelay(): number {
  return (
    ACQUIRE_POLL_MIN_MS +
    Math.floor(Math.random() * (ACQUIRE_POLL_MAX_MS - ACQUIRE_POLL_MIN_MS))
  );
}

export class RedisDistributedLock implements DistributedLock {
  /**
   * `identity` is what we write into the leader key so isLeader() can
   * recognise our own claim across calls. Defaults to the shard id;
   * tests inject a stable string. Different shards naturally have
   * different identities so the election is deterministic per-key
   * (whoever races to SET NX first holds it; the others drop out).
   */
  private readonly identity: string;

  constructor(
    private readonly redis: RedisLike = getRedisClient(),
    identity?: string,
  ) {
    this.identity = identity ?? `shard:${config.bot.shardId}`;
  }

  async run<T>(
    key: string,
    fn: () => Promise<T>,
    opts?: { timeoutMs?: number },
  ): Promise<T> {
    const deadline =
      opts?.timeoutMs && opts.timeoutMs > 0
        ? Date.now() + opts.timeoutMs
        : Number.POSITIVE_INFINITY;
    const ttlMs =
      opts?.timeoutMs && opts.timeoutMs > 0 && opts.timeoutMs < DEFAULT_LOCK_TTL_MS
        ? // If the caller cares about a short timeout, the TTL can be
          // tighter — gives a faster failover if the fn deadlocks.
          opts.timeoutMs
        : DEFAULT_LOCK_TTL_MS;
    const owner = randomBytes(16).toString("hex");

    // Acquire loop. Treat a rejected SET (Redis network blip) the
    // same as "lock not acquired" — back off and retry until the
    // caller's timeout. Without this, a transient ETIMEDOUT escapes
    // `run()` as an unhandled rejection; main.ts's unhandledRejection
    // handler then schedules process.exit(1), which kills the bot on
    // a Redis hiccup mid-ready.
    //
    // The deadline is checked BEFORE every SET — if the previous
    // holder released the key while we were sleeping but the
    // caller's `timeoutMs` window has since elapsed, we must NOT
    // claim the now-free lock. Caller asked us to give up by the
    // deadline; acquiring late silently violates that contract and
    // (more concretely) made the unit-test for `timeoutMs` flaky
    // depending on whether the polling sleep happened to outrun the
    // holder's release.
    while (true) {
      if (Date.now() >= deadline) {
        throw new Error(`lock '${key}' acquire timed out`);
      }
      let acquired: string | null = null;
      try {
        acquired = await this.redis.set(
          lockKey(key),
          owner,
          "PX",
          ttlMs,
          "NX",
        );
      } catch {
        acquired = null;
      }
      if (acquired === "OK") break;
      // Cap the polling sleep at the time remaining before the
      // deadline — otherwise a long jitter window can park us past
      // the deadline and waste the caller's budget on a guaranteed-
      // doomed extra SET attempt.
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(`lock '${key}' acquire timed out`);
      }
      await sleep(Math.min(jitterDelay(), remaining));
    }

    try {
      return await fn();
    } finally {
      try {
        await this.redis.eval(RELEASE_SCRIPT, 1, lockKey(key), owner);
      } catch {
        // If release fails the lock will expire on its own; nothing
        // we can do without retry storms.
      }
    }
  }

  async isLeader(key: string): Promise<boolean> {
    // Best-effort leader election: try to claim leadership with our
    // identity; if someone else (other shard) already holds it, fail.
    // If WE hold it from a prior check, refresh the TTL so we stay
    // elected as long as the caller keeps polling.
    const k = leaderKey(key);
    let claim: string | null = null;
    try {
      claim = await this.redis.set(k, this.identity, "PX", LEADER_TTL_MS, "NX");
    } catch {
      // Network blip: be conservative and return false rather than
      // letting two shards both think they're leader.
      return false;
    }
    if (claim === "OK") return true;
    let current: string | null = null;
    try {
      current = await this.redis.get(k);
    } catch {
      return false;
    }
    if (current === this.identity) {
      // We're still the leader — refresh the TTL so we don't lose
      // election just because the caller's polling interval is near
      // the TTL boundary.
      try {
        await this.redis.pexpire(k, LEADER_TTL_MS);
      } catch {
        /* best-effort */
      }
      return true;
    }
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms).unref());
}

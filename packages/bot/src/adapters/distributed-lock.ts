/**
 * DistributedLock — mutual exclusion across shard processes.
 *
 * Used for serialising operations that must run exactly once across
 * the whole deployment:
 *
 *  - global slash-command reconcile (only shard 0 should call
 *    Discord's `application.commands.set(global)`, otherwise N
 *    shards stomp each other);
 *  - DB migrations (only one process runs umzug at startup);
 *  - one-off maintenance tasks scheduled from the admin UI.
 *
 * In single-shard mode the lock is a noop — there's nothing to
 * serialise against. The interface exists today so call sites can
 * code defensively (`await lock.run('global-cmd-reconcile', …)`)
 * and a Redis-SETNX implementation can swap in without touching them.
 */

export interface DistributedLock {
  /**
   * Acquire the lock identified by `key`, run `fn`, release. Throws
   * if the lock cannot be acquired within `timeoutMs` (default
   * `Infinity` — wait forever). The lock is held only for the
   * duration of `fn` plus the implementation's own watchdog grace.
   */
  run<T>(
    key: string,
    fn: () => Promise<T>,
    opts?: { timeoutMs?: number },
  ): Promise<T>;

  /**
   * Best-effort "am I the leader for this key" check without
   * acquiring the lock. Used to gate background timers that should
   * only run on one process (e.g. a daily cleanup job). The leader
   * answer is inherently racey across processes — callers must be
   * idempotent. Implementations are free to return `true`
   * conservatively (in-process mode always says yes).
   */
  isLeader(key: string): Promise<boolean>;
}

/**
 * Single-process lock implementation. Serialises within this process
 * via a per-key promise chain; across processes the lock is a noop
 * — there is no other process to lock against.
 *
 * Behaviour:
 *  - `run(k, fn)` waits for the previous `run(k, …)` on this
 *    process to settle, then runs `fn`. The chain is rebuilt every
 *    call so a stalled chain doesn't accumulate forever.
 *  - `isLeader(k)` always returns `true` — there is exactly one
 *    process and it owns every key.
 */
export class InProcessDistributedLock implements DistributedLock {
  private readonly chains = new Map<string, Promise<unknown>>();

  async run<T>(
    key: string,
    fn: () => Promise<T>,
    opts?: { timeoutMs?: number },
  ): Promise<T> {
    const prev = this.chains.get(key) ?? Promise.resolve();
    // Capture this run's promise so the next caller waits for us. We
    // do NOT propagate fn's rejection into the next run — a thrown
    // fn shouldn't deadlock the next holder.
    let resolve!: () => void;
    const release = new Promise<void>((r) => {
      resolve = r;
    });
    this.chains.set(key, release);
    try {
      await prev;
      if (opts?.timeoutMs && opts.timeoutMs > 0) {
        return await Promise.race([
          fn(),
          new Promise<T>((_, rej) =>
            setTimeout(
              () => rej(new Error(`lock '${key}' timed out`)),
              opts.timeoutMs,
            ).unref(),
          ),
        ]);
      }
      return await fn();
    } finally {
      resolve();
      // Compact: if we're still the tail of the chain, drop the
      // entry so an idle key doesn't leak a Map slot. A racing next
      // caller already grabbed `release` before we ran, so dropping
      // here is safe.
      if (this.chains.get(key) === release) this.chains.delete(key);
    }
  }

  async isLeader(_key: string): Promise<boolean> {
    return true;
  }
}

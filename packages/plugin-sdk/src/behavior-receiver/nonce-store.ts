import { nowSeconds } from "./crypto.js";
import type { NonceStore } from "./verify.js";

export interface NonceStoreOptions {
  /**
   * The most nonces kept. When full, the oldest is forgotten first, so a
   * flood of requests cannot grow the store without bound.
   */
  maxEntries?: number;
  /** Unix time in seconds. Defaults to the clock. */
  now?: () => number;
}

/** A NonceStore in this process's memory, with expiry and a size cap. */
export interface MemoryNonceStore extends NonceStore {
  has(nonce: string): boolean;
  /** False when the nonce is already kept and not expired. */
  set(nonce: string, expiresAt: number): boolean;
  readonly size: number;
}

export function createNonceStore(
  options: NonceStoreOptions = {},
): MemoryNonceStore {
  const maxEntries = options.maxEntries ?? 10_000;
  if (!Number.isInteger(maxEntries) || maxEntries < 1) {
    throw new RangeError(
      `maxEntries must be a positive integer, got ${maxEntries}`,
    );
  }
  const now = options.now ?? nowSeconds;
  // insertion order, which is close to expiry order
  const expiries = new Map<string, number>();

  // a request stays fresh up to and including its expiry second
  const live = (nonce: string, t: number) =>
    (expiries.get(nonce) ?? -Infinity) >= t;

  return {
    has: (nonce) => live(nonce, now()),
    set(nonce, expiresAt) {
      const t = now();
      if (live(nonce, t)) return false;
      for (const [n, expiry] of expiries) {
        if (expiry >= t) break;
        expiries.delete(n);
      }
      expiries.delete(nonce);
      while (expiries.size >= maxEntries) {
        expiries.delete(expiries.keys().next().value!);
      }
      expiries.set(nonce, expiresAt);
      return true;
    },
    get size() {
      return expiries.size;
    },
  };
}

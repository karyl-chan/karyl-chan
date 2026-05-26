/**
 * Lazy shared Redis client for adapter implementations.
 *
 * One ioredis connection is enough for every Redis-backed adapter in
 * the process — they share command latency budget anyway, and ioredis
 * pipelines commands per connection. Allocating one connection per
 * store would just multiply the file-descriptor count without helping.
 *
 * The client is only constructed when `getRedisClient()` is first
 * called — so a `inprocess` deployment never opens a socket even if
 * the package is imported.
 *
 * Connection string comes from `REDIS_URL`. Tests inject a stub via
 * `setRedisClientForTests(...)`.
 */

import { Redis, type RedisOptions } from "ioredis";

/**
 * The narrow subset of the ioredis API the adapters actually use. We
 * keep the type loose enough that a test stub (Map-backed) can implement
 * it without dragging in the full ioredis surface.
 */
export interface RedisLike {
  get(key: string): Promise<string | null>;
  set(
    key: string,
    value: string,
    ...args: Array<string | number>
  ): Promise<string | null>;
  del(...keys: string[]): Promise<number>;
  hset(key: string, ...args: Array<string | number>): Promise<number>;
  hget(key: string, field: string): Promise<string | null>;
  hdel(key: string, ...fields: string[]): Promise<number>;
  hgetall(key: string): Promise<Record<string, string>>;
  expire(key: string, seconds: number): Promise<number>;
  pexpire(key: string, milliseconds: number): Promise<number>;
  pttl(key: string): Promise<number>;
  eval(
    script: string,
    numKeys: number,
    ...args: Array<string | number>
  ): Promise<unknown>;
  scan(
    cursor: string | number,
    ...args: Array<string | number>
  ): Promise<[string, string[]]>;
  ping(): Promise<string>;
  quit(): Promise<string>;
}

let client: RedisLike | null = null;
let testClient: RedisLike | null = null;

function defaultOptions(): RedisOptions {
  return {
    // Lazy-connect: we already lazy-construct the client on first
    // adapter call. enableOfflineQueue=true (the default) lets a
    // burst of commands buffer during the initial handshake — adapter
    // calls won't fail just because we beat the connection.
    lazyConnect: false,
    enableOfflineQueue: true,
    maxRetriesPerRequest: 3,
    retryStrategy(times) {
      // Cap reconnect interval at 2s; ioredis's default doubles forever.
      return Math.min(2_000, 100 * Math.pow(2, Math.min(times, 5)));
    },
  };
}

/** Get (or lazily construct) the shared Redis client. */
export function getRedisClient(): RedisLike {
  if (testClient) return testClient;
  if (client) return client;
  const url = (process.env.REDIS_URL ?? "").trim();
  if (!url) {
    throw new Error(
      "REDIS_URL is not set; a Redis-backed adapter was requested without a connection string.",
    );
  }
  // ioredis's `set` / `hset` overloads don't simplify down to the
  // narrow RedisLike shape we model — the runtime contract is
  // identical, so cast through unknown. Tests inject a stub that
  // implements RedisLike directly.
  client = new Redis(url, defaultOptions()) as unknown as RedisLike;
  return client;
}

/** Test-only — install a stub client for the next getRedisClient() calls. */
export function setRedisClientForTests(stub: RedisLike | null): void {
  testClient = stub;
}

/** Test-only — drop the real client (does NOT call quit). */
export function __resetRedisClientForTests(): void {
  client = null;
  testClient = null;
}

/**
 * Close the client on graceful shutdown. Safe to call multiple times
 * — once the client has been quit, subsequent calls are no-ops.
 */
export async function closeRedisClient(): Promise<void> {
  const live = client;
  if (!live) return;
  client = null;
  try {
    await live.quit();
  } catch {
    /* best-effort */
  }
}

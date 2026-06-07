/**
 * Lazy ioredis client for the SDK's optional Streams consumer.
 *
 * ioredis is an OPTIONAL dependency: a plugin that runs on the default
 * HTTP `/events` transport never imports it. We only `import("ioredis")`
 * when `streamsTransportEnabled()` is true (`EVENT_BUS=redis-streams` +
 * `REDIS_URL`), so the heavy module + TCP socket cost is paid only by
 * plugins that opted into the Streams transport.
 *
 * Mirrors the bot's `adapters/redis/client.ts` connection options so
 * both ends behave identically (bounded reconnect backoff, offline
 * queue during the handshake).
 */

import type { RedisStreamsLike } from "./streams-consumer.js";

/**
 * Is the Streams event transport enabled for this plugin process?
 * Both signals must be present — the env flag AND a connection string —
 * otherwise we fall back to the HTTP `/events` route (default-off).
 */
export function streamsTransportEnabled(): boolean {
  const bus = (process.env.EVENT_BUS ?? "").trim().toLowerCase();
  const url = (process.env.REDIS_URL ?? "").trim();
  return bus === "redis-streams" && url.length > 0;
}

let client: RedisStreamsLike | null = null;

/**
 * Construct (once) and return the shared Streams client. Throws if
 * `REDIS_URL` is unset — callers gate on `streamsTransportEnabled()`
 * first, so reaching here without a URL is a programming error.
 *
 * Dynamic import keeps ioredis out of the module graph for HTTP-only
 * plugins.
 */
export async function getStreamsClient(): Promise<RedisStreamsLike> {
  if (client) return client;
  const url = (process.env.REDIS_URL ?? "").trim();
  if (!url) {
    throw new Error(
      "REDIS_URL is not set; the redis-streams event transport was requested without a connection string.",
    );
  }
  const { Redis } = await import("ioredis");
  const redis = new Redis(url, {
    enableOfflineQueue: true,
    maxRetriesPerRequest: null, // blocking XREADGROUP must not be capped
    retryStrategy(times: number) {
      return Math.min(2_000, 100 * Math.pow(2, Math.min(times, 5)));
    },
  });
  // ioredis's typed command overloads don't reduce to our narrow
  // RedisStreamsLike shape; the runtime contract is identical. Cast
  // through unknown — test stubs implement RedisStreamsLike directly.
  client = redis as unknown as RedisStreamsLike;
  return client;
}

/** Close the client on graceful shutdown. Safe to call repeatedly. */
export async function closeStreamsClient(): Promise<void> {
  const live = client;
  if (!live) return;
  client = null;
  try {
    await live.quit();
  } catch {
    /* best-effort */
  }
}

/** Test-only — drop the cached client without quitting. */
export function __resetStreamsClientForTests(): void {
  client = null;
}

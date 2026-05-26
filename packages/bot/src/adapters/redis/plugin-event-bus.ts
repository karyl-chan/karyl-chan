/**
 * Redis Streams PluginEventBus — Phase 2.2 (producer side).
 *
 * Replaces the synchronous HTTP fan-out (per-plugin POST to /events)
 * with `XADD plugin-events:<pluginKey> * type <eventType> data <json>`.
 * Plugins consume their own stream via SDK-side consumer group
 * subscriptions; the bot is decoupled from plugin readiness — if a
 * plugin restarts the events queue in Redis until it picks them up
 * again.
 *
 * **Producer-only in this commit.** The SDK-side stream consumer
 * (the half of 2.2 that lets plugins actually receive events from
 * Streams) ships in a follow-up SDK release. Until that lands,
 * setting `EVENT_BUS=redis-streams` produces a deployment where the
 * bot writes events into Redis but plugins still need HTTP fan-out
 * to actually receive them — i.e. don't flip the env until SDK
 * 0.8+ is in place.
 *
 * Stream shape:
 *   key: karyl:events:<pluginKey>
 *   fields:
 *     type    → event type string (e.g. "guild.message_create")
 *     data    → JSON-encoded payload (verbatim from the dispatcher)
 *     trace   → traceparent header value (Phase 0.9)
 *
 * Retention is configured via Redis MAXLEN at write time so a
 * never-consumed stream doesn't grow unbounded.
 */

import type { PluginEventBus } from "../plugin-event-bus.js";
import {
  newTraceContext,
  TRACEPARENT_HEADER,
} from "../../utils/trace-context.js";
import { getRedisClient, type RedisLike } from "./client.js";

interface RedisStreamsEventBusOptions {
  /**
   * Approximate cap on stream length. XADD MAXLEN ~ N keeps the
   * trim cost near-constant while bounding stream size. Default
   * 100_000 — enough headroom for a plugin restart of several
   * minutes at our target traffic.
   */
  maxLen?: number;
}

const DEFAULT_MAXLEN = 100_000;
const STREAM_PREFIX = "karyl:events:";

const streamKey = (pluginKey: string) => `${STREAM_PREFIX}${pluginKey}`;

export class RedisStreamsPluginEventBus implements PluginEventBus {
  private readonly maxLen: number;

  constructor(
    private readonly redis: RedisLike = getRedisClient(),
    opts: RedisStreamsEventBusOptions = {},
  ) {
    this.maxLen = Math.max(1, opts.maxLen ?? DEFAULT_MAXLEN);
  }

  dispatch(eventType: string, data: unknown): void {
    // The interface is fire-and-forget; we don't await the XADD
    // because the caller (Discord gateway event handler) needs to
    // return quickly. Errors are swallowed — same contract as the
    // HTTP InProcess default, which logs internally.
    //
    // For plugin-specific stream addressing we'd need the
    // subscription index — that lives in plugin-event-bridge.
    // This producer dispatches to a SINGLE shared stream per
    // eventType (karyl:events:<eventType>); the SDK consumer
    // filters by pluginKey on consume. Trade-off: one stream per
    // event type is simpler than per-plugin streams and lets
    // plugins join late without backfill, at the cost of a small
    // filter step on consume.
    const trace = newTraceContext();
    const key = streamKey(eventType);
    const fields: Array<string | number> = [
      "MAXLEN",
      "~",
      this.maxLen,
      "*",
      "type",
      eventType,
      "data",
      JSON.stringify(data),
      "trace",
      trace.traceparent,
      TRACEPARENT_HEADER,
      trace.traceparent,
    ];
    // XADD signature in ioredis: (key, ...args). We rely on the
    // RedisLike interface's `eval` / `set` / `del` having the same
    // (...rest: Array<string|number>) shape; XADD isn't in our
    // narrow interface yet because it's only used here. Type the
    // ioredis client as `unknown` and call via a cast.
    void (this.redis as unknown as {
      xadd?: (
        key: string,
        ...args: Array<string | number>
      ) => Promise<unknown>;
    })
      .xadd?.(key, ...fields)
      .catch(() => undefined);
  }

  async stop(): Promise<void> {
    // The shared Redis client is closed by `closeRedisClient()` in
    // the bot's gracefulShutdown — nothing per-bus to do.
  }
}

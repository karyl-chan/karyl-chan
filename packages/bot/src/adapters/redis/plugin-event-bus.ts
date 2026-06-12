/**
 * Redis Streams PluginEventBus — producer side.
 *
 * PM-8: one stream PER PLUGIN — `karyl:plugin:<pluginKey>:events` — the
 * plugin's private mailbox. The bridge (`plugin-event-bridge.service.ts`)
 * resolves reach (feature-scoped vs approved-global routes) per plugin
 * and only then calls `dispatchToPlugin`, so an event lands exclusively
 * in the mailboxes of plugins entitled to see it. The previous model
 * (one shared stream per event TYPE, every plugin's consumer group on
 * the same key) made bot-side per-plugin filtering impossible — any
 * consumer could read the full firehose regardless of what the bot
 * decided.
 *
 * The bot stays decoupled from plugin readiness — if a plugin restarts,
 * its events queue in its mailbox until the SDK `StreamsConsumer`
 * drains them, instead of being dropped on a failed POST.
 *
 * Stream shape:
 *   key: karyl:plugin:<pluginKey>:events
 *   fields:
 *     type        → event type string (e.g. "guild.message_create")
 *     data        → JSON-encoded payload (verbatim from the dispatcher)
 *     trace       → traceparent header value (legacy field name)
 *     traceparent → same value under the canonical W3C header name
 *
 * Retention is configured via Redis MAXLEN at write time so a
 * never-consumed mailbox doesn't grow unbounded. The cap is per
 * plugin; total Redis footprint is bounded by plugin count × MAXLEN.
 */

import type { PluginEventBus } from "../plugin-event-bus.js";
import {
  newTraceContext,
  TRACEPARENT_HEADER,
} from "../../utils/trace-context.js";
import { getRedisClient, type RedisLike } from "./client.js";

interface RedisStreamsEventBusOptions {
  /**
   * Approximate cap on each plugin mailbox's length. XADD MAXLEN ~ N
   * keeps the trim cost near-constant while bounding stream size.
   * Default 100_000 — enough headroom for a plugin restart of several
   * minutes at our target traffic.
   */
  maxLen?: number;
}

const DEFAULT_MAXLEN = 100_000;

/** Keep in sync with the SDK's `pluginStreamKeyFor` (streams-protocol.ts). */
export const PLUGIN_STREAM_PREFIX = "karyl:plugin:";

const mailboxKey = (pluginKey: string) =>
  `${PLUGIN_STREAM_PREFIX}${pluginKey}:events`;

export class RedisStreamsPluginEventBus implements PluginEventBus {
  private readonly maxLen: number;

  constructor(
    private readonly redis: RedisLike = getRedisClient(),
    opts: RedisStreamsEventBusOptions = {},
  ) {
    this.maxLen = Math.max(1, opts.maxLen ?? DEFAULT_MAXLEN);
  }

  dispatchToPlugin(
    _pluginId: number,
    pluginKey: string,
    eventType: string,
    data: unknown,
  ): void {
    // Fire-and-forget; the caller (Discord gateway event handler) needs
    // to return quickly. Errors are swallowed — same contract as the
    // HTTP InProcess default, which logs internally.
    const trace = newTraceContext();
    const key = mailboxKey(pluginKey);
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
    // XADD signature in ioredis: (key, ...args). XADD isn't in our
    // narrow RedisLike interface because it's only used here; call via
    // a cast.
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

/**
 * SDK-side Redis Streams consumer (PR-1.1 + PR-1.3).
 *
 * The bot's `RedisStreamsPluginEventBus` producer XADDs every Discord
 * event to a shared per-type stream (`karyl:events:<eventType>`). This
 * consumer is the other half: when a plugin runs with
 * `EVENT_BUS=redis-streams`, the SDK joins a per-plugin consumer group
 * on each subscribed stream, reads new entries with `XREADGROUP`,
 * dispatches each through the SAME `dispatchEvent` path the HTTP
 * `/events` route uses, and `XACK`s on success. Plugin authors don't
 * change a line — `eventHandlers` is the only surface either way.
 *
 * Reliability (PR-1.3): a periodic `XAUTOCLAIM` sweep reclaims entries
 * that were delivered but never acked (handler crash, plugin restart
 * mid-handle). Each reclaimed entry is retried until its delivery count
 * hits `maxDeliveries`, after which it's moved to the dead-letter stream
 * (`karyl:events:<eventType>:dlq`) and acked off the source so a poison
 * message can't block the group's pending list forever. Parse failures
 * go straight to the DLQ.
 *
 * Default-off: nothing here runs unless the plugin process is started
 * with `EVENT_BUS=redis-streams` AND `REDIS_URL` set. With neither, the
 * SDK behaves exactly as before (HTTP `/events`).
 */

import {
  computeLag,
  decideRedelivery,
  dlqKeyFor,
  parseStreamEntry,
  streamKeyFor,
  type ParsedStreamEntry,
} from "./streams-protocol.js";

/**
 * Narrow subset of the ioredis Stream API the consumer uses. Kept loose
 * so a Map-backed test stub can implement it without the full ioredis
 * surface (mirrors the bot's `RedisLike`). The real client is passed in
 * by `definePlugin` only when the transport is enabled, so ioredis stays
 * an optional dependency the type layer never forces.
 */
export interface RedisStreamsLike {
  xgroup(...args: Array<string | number>): Promise<unknown>;
  xreadgroup(...args: Array<string | number>): Promise<unknown>;
  xack(key: string, group: string, ...ids: string[]): Promise<number>;
  xautoclaim(...args: Array<string | number>): Promise<unknown>;
  xadd(key: string, ...args: Array<string | number>): Promise<unknown>;
  xlen(key: string): Promise<number>;
  xinfo(...args: Array<string | number>): Promise<unknown>;
  xpending(...args: Array<string | number>): Promise<unknown>;
  quit(): Promise<string>;
}

export interface StreamsConsumerLogger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

export interface StreamsConsumerOptions {
  redis: RedisStreamsLike;
  /** This plugin's key — names the consumer group + consumer. */
  pluginKey: string;
  /** Event types the plugin subscribes to (keys of `eventHandlers`). */
  eventTypes: string[];
  /**
   * Same callback `createPluginServer` receives for the `/events` route.
   * Resolving the handler by type + running it inside try/catch lives in
   * `definePlugin`; the consumer just hands off the decoded entry.
   */
  dispatchEvent: (eventType: string, data: unknown) => Promise<void>;
  log: StreamsConsumerLogger;
  /** Max entries pulled per XREADGROUP. Default 64. */
  batchCount?: number;
  /** XREADGROUP BLOCK milliseconds. Default 5000. */
  blockMs?: number;
  /**
   * Redeliveries before an entry is dead-lettered. An entry delivered
   * this many times without an ack is poison-by-timeout. Default 5.
   */
  maxDeliveries?: number;
  /**
   * How long (ms) an entry must sit unacked before XAUTOCLAIM reclaims
   * it. Default 60_000 — well past a healthy handler's runtime.
   */
  claimMinIdleMs?: number;
  /** Interval (ms) between reclaim + lag sweeps. Default 30_000. */
  sweepIntervalMs?: number;
}

const DEFAULTS = {
  batchCount: 64,
  blockMs: 5_000,
  maxDeliveries: 5,
  claimMinIdleMs: 60_000,
  sweepIntervalMs: 30_000,
} as const;

/** Consumer-group name for a plugin. Stable across restarts so the PEL survives. */
export function groupNameFor(pluginKey: string): string {
  return `kc-consumer:${pluginKey}`;
}

/** Lag snapshot for one stream, exposed to the metrics surface / logs. */
export interface LagSnapshot {
  eventType: string;
  lag: number;
}

export class StreamsConsumer {
  private readonly redis: RedisStreamsLike;
  private readonly pluginKey: string;
  private readonly group: string;
  private readonly consumer: string;
  private readonly eventTypes: string[];
  private readonly streamKeys: string[];
  private readonly dispatchEvent: StreamsConsumerOptions["dispatchEvent"];
  private readonly log: StreamsConsumerLogger;
  private readonly batchCount: number;
  private readonly blockMs: number;
  private readonly maxDeliveries: number;
  private readonly claimMinIdleMs: number;
  private readonly sweepIntervalMs: number;

  private running = false;
  private readLoop: Promise<void> | null = null;
  private sweepTimer: NodeJS.Timeout | null = null;
  private lastLag = new Map<string, number>();

  constructor(opts: StreamsConsumerOptions) {
    this.redis = opts.redis;
    this.pluginKey = opts.pluginKey;
    this.group = groupNameFor(opts.pluginKey);
    // A unique-ish consumer name per process: the group's PEL is keyed
    // by consumer, so a restarted process reading under a fresh name
    // leaves the old PEL entries for XAUTOCLAIM to reclaim.
    this.consumer = `${opts.pluginKey}-${process.pid}`;
    this.eventTypes = [...new Set(opts.eventTypes)];
    this.streamKeys = this.eventTypes.map(streamKeyFor);
    this.dispatchEvent = opts.dispatchEvent;
    this.log = opts.log;
    this.batchCount = opts.batchCount ?? DEFAULTS.batchCount;
    this.blockMs = opts.blockMs ?? DEFAULTS.blockMs;
    this.maxDeliveries = opts.maxDeliveries ?? DEFAULTS.maxDeliveries;
    this.claimMinIdleMs = opts.claimMinIdleMs ?? DEFAULTS.claimMinIdleMs;
    this.sweepIntervalMs = opts.sweepIntervalMs ?? DEFAULTS.sweepIntervalMs;
  }

  /** Create the consumer group on every subscribed stream (idempotent). */
  async ensureGroups(): Promise<void> {
    for (const key of this.streamKeys) {
      try {
        // MKSTREAM creates the stream if the producer hasn't written yet;
        // `$` starts the cursor at "only new entries from now".
        await this.redis.xgroup(
          "CREATE",
          key,
          this.group,
          "$",
          "MKSTREAM",
        );
      } catch (err) {
        // BUSYGROUP = group already exists (a previous run / another
        // replica). That's the steady-state path, not an error.
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("BUSYGROUP")) {
          this.log.warn("failed to create consumer group", {
            key,
            group: this.group,
            error: msg,
          });
        }
      }
    }
  }

  start(): void {
    if (this.running || this.streamKeys.length === 0) return;
    this.running = true;
    this.readLoop = this.runReadLoop();
    this.sweepTimer = setInterval(() => {
      void this.sweepOnce();
    }, this.sweepIntervalMs);
    if (typeof this.sweepTimer.unref === "function") this.sweepTimer.unref();
    this.log.info("redis-streams consumer started", {
      group: this.group,
      consumer: this.consumer,
      eventTypes: this.eventTypes,
    });
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    // The read loop wakes from its BLOCK within `blockMs`; await it so a
    // dispatch in flight finishes before we return.
    await this.readLoop?.catch(() => undefined);
    this.readLoop = null;
  }

  /** Most recent lag per event type (consumer-group entries unconsumed). */
  lagSnapshot(): LagSnapshot[] {
    return this.eventTypes.map((eventType) => ({
      eventType,
      lag: this.lastLag.get(eventType) ?? 0,
    }));
  }

  // ── read loop ────────────────────────────────────────────────────────

  private async runReadLoop(): Promise<void> {
    // `>` = deliver only entries never delivered to this group.
    while (this.running) {
      let res: unknown;
      try {
        res = await this.redis.xreadgroup(
          "GROUP",
          this.group,
          this.consumer,
          "COUNT",
          this.batchCount,
          "BLOCK",
          this.blockMs,
          "STREAMS",
          ...this.streamKeys,
          ...this.streamKeys.map(() => ">"),
        );
      } catch (err) {
        if (!this.running) return;
        this.log.warn("xreadgroup failed; backing off", {
          error: err instanceof Error ? err.message : String(err),
        });
        await sleep(Math.min(this.blockMs, 2_000));
        continue;
      }
      if (!res) {
        // BLOCK timeout / no new entries. A real BLOCK already yielded
        // for `blockMs`; a fake (or a server that returns instantly)
        // would spin a tight microtask loop and starve timers, so yield
        // a macrotask before looping.
        await sleep(0);
        continue;
      }
      await this.handleReadReply(res);
    }
  }

  /**
   * XREADGROUP reply: `[ [streamKey, [ [id, fields], … ] ], … ]`.
   * Dispatch + ack each entry; on dispatch failure we deliberately do
   * NOT ack — the entry stays pending and the XAUTOCLAIM sweep retries
   * it (and eventually DLQs it), giving at-least-once delivery.
   */
  private async handleReadReply(reply: unknown): Promise<void> {
    if (!Array.isArray(reply)) return;
    for (const stream of reply) {
      if (!Array.isArray(stream) || stream.length < 2) continue;
      const [key, entries] = stream as [string, unknown];
      if (typeof key !== "string" || !Array.isArray(entries)) continue;
      for (const entry of entries) {
        await this.processFreshEntry(key, entry);
      }
    }
  }

  private async processFreshEntry(key: string, entry: unknown): Promise<void> {
    const parsed = parseStreamEntry(entry);
    if (!parsed) {
      // Poison on first delivery — DLQ immediately. We can still read
      // the raw id for the DLQ + ack even when the body is unusable.
      const id = Array.isArray(entry) ? String(entry[0] ?? "") : "";
      const rawFields = Array.isArray(entry) && Array.isArray(entry[1])
        ? (entry[1] as unknown[]).filter((f): f is string => typeof f === "string")
        : [];
      await this.deadLetter(key, id, rawFields, "parse-failure");
      return;
    }
    const ok = await this.runHandler(parsed);
    if (ok) {
      await this.ackSafely(key, parsed.id);
    }
    // On failure: leave pending → reclaimed + retried by the sweep.
  }

  private async runHandler(parsed: ParsedStreamEntry): Promise<boolean> {
    try {
      await this.dispatchEvent(parsed.type, parsed.data);
      return true;
    } catch (err) {
      this.log.error("event handler threw (stream)", {
        type: parsed.type,
        id: parsed.id,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  // ── reclaim + lag sweep ──────────────────────────────────────────────

  private async sweepOnce(): Promise<void> {
    if (!this.running) return;
    for (let i = 0; i < this.streamKeys.length; i++) {
      const key = this.streamKeys[i];
      const eventType = this.eventTypes[i];
      try {
        await this.reclaimStream(key);
        await this.refreshLag(key, eventType);
      } catch (err) {
        this.log.warn("stream sweep failed", {
          key,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /**
   * Reclaim long-idle pending entries with XAUTOCLAIM and retry / DLQ
   * each. XAUTOCLAIM returns `[cursor, [ [id, fields], … ], [deletedIds]]`
   * and bumps each returned entry's delivery count — that count is what
   * we threshold on for the DLQ decision.
   */
  private async reclaimStream(key: string): Promise<void> {
    let cursor = "0-0";
    // Bound the loop so one sweep can't spin forever on a hot stream.
    for (let page = 0; page < 16; page++) {
      const res = await this.redis.xautoclaim(
        key,
        this.group,
        this.consumer,
        this.claimMinIdleMs,
        cursor,
        "COUNT",
        this.batchCount,
      );
      if (!Array.isArray(res) || res.length < 2) return;
      cursor = typeof res[0] === "string" ? res[0] : "0-0";
      const entries = Array.isArray(res[1]) ? res[1] : [];
      for (const entry of entries) {
        await this.processReclaimedEntry(key, entry);
      }
      if (cursor === "0-0" || entries.length === 0) return;
    }
  }

  private async processReclaimedEntry(
    key: string,
    entry: unknown,
  ): Promise<void> {
    const parsed = parseStreamEntry(entry);
    const id = parsed?.id ?? (Array.isArray(entry) ? String(entry[0] ?? "") : "");
    if (!id) return;

    // Delivery count for the DLQ decision. XAUTOCLAIM itself doesn't
    // return the per-entry count, so we read it from XPENDING for this
    // id. A failed lookup is treated as "1 delivery" (retry) — we'd
    // rather over-retry than drop.
    const deliveries = await this.deliveryCount(key, id);

    if (!parsed) {
      await this.deadLetter(
        key,
        id,
        Array.isArray(entry) && Array.isArray(entry[1])
          ? (entry[1] as unknown[]).filter((f): f is string => typeof f === "string")
          : [],
        "parse-failure",
      );
      return;
    }

    if (decideRedelivery(deliveries, this.maxDeliveries) === "dlq") {
      await this.deadLetter(key, id, parsed.raw, "max-deliveries");
      return;
    }

    const ok = await this.runHandler(parsed);
    if (ok) await this.ackSafely(key, parsed.id);
    // else leave pending for the next sweep (count keeps climbing → DLQ).
  }

  /** Per-id delivery count via `XPENDING <key> <group> - + 1 <consumer?>`. */
  private async deliveryCount(key: string, id: string): Promise<number> {
    try {
      // XPENDING <key> <group> <start> <end> <count> returns
      // `[ [id, consumer, idleMs, deliveryCount], … ]`. Scoping start=end=id
      // pins it to the single entry we're about to (re)process.
      const pending = await this.redis.xpending(key, this.group, id, id, 1);
      if (Array.isArray(pending) && pending.length > 0) {
        const row = pending[0];
        if (Array.isArray(row) && row.length >= 4) {
          const count = Number(row[3]);
          if (Number.isFinite(count) && count > 0) return count;
        }
      }
    } catch {
      /* fall through to the safe default */
    }
    return 1;
  }

  /** Move an entry to the DLQ stream and ACK it off the source. */
  private async deadLetter(
    key: string,
    id: string,
    rawFields: string[],
    reason: string,
  ): Promise<void> {
    if (!id) return;
    const dlqKey = dlqKeyFor(this.streamEventType(key));
    try {
      // Preserve every original field verbatim + stamp the DLQ reason +
      // the source id so the entry is self-describing for an operator.
      await this.redis.xadd(
        dlqKey,
        "*",
        ...rawFields,
        "dlq_reason",
        reason,
        "dlq_source_id",
        id,
      );
      await this.ackSafely(key, id);
      this.log.warn("event moved to DLQ", { dlqKey, sourceId: id, reason });
    } catch (err) {
      this.log.error("failed to dead-letter event", {
        key,
        id,
        reason,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async ackSafely(key: string, id: string): Promise<void> {
    try {
      await this.redis.xack(key, this.group, id);
    } catch (err) {
      this.log.warn("xack failed", {
        key,
        id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Read consumer-group lag via XINFO GROUPS and stash it for the snapshot. */
  private async refreshLag(key: string, eventType: string): Promise<void> {
    try {
      const [groups, length] = await Promise.all([
        this.redis.xinfo("GROUPS", key),
        this.redis.xlen(key),
      ]);
      const mine = findGroupInfo(groups, this.group);
      const lag = computeLag({
        reportedLag: mine.lag,
        streamLength: typeof length === "number" ? length : 0,
        entriesRead: mine.entriesRead,
      });
      this.lastLag.set(eventType, lag);
      if (lag > 0) {
        this.log.info("consumer lag", { eventType, group: this.group, lag });
      }
    } catch {
      /* lag is best-effort telemetry — never break the sweep over it */
    }
  }

  private streamEventType(key: string): string {
    const i = this.streamKeys.indexOf(key);
    return i >= 0 ? this.eventTypes[i] : key;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Parse one group's `lag` + `entries-read` out of XINFO GROUPS' reply.
 * ioredis returns each group as a flat `[field, value, …]` array.
 */
export function findGroupInfo(
  groups: unknown,
  groupName: string,
): { lag: number | null; entriesRead: number | null } {
  if (!Array.isArray(groups)) return { lag: null, entriesRead: null };
  for (const g of groups) {
    if (!Array.isArray(g)) continue;
    const map: Record<string, unknown> = {};
    for (let i = 0; i + 1 < g.length; i += 2) {
      if (typeof g[i] === "string") map[g[i] as string] = g[i + 1];
    }
    if (map.name === groupName) {
      const lag = toNumberOrNull(map.lag);
      const entriesRead = toNumberOrNull(map["entries-read"]);
      return { lag, entriesRead };
    }
  }
  return { lag: null, entriesRead: null };
}

function toNumberOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

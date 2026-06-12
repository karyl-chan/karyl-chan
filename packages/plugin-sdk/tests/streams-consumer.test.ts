/**
 * StreamsConsumer behaviour against an in-memory fake Redis that
 * implements just the Stream commands the consumer touches. No live
 * Redis. We assert the two load-bearing paths:
 *
 *   - happy path: XREADGROUP entry → dispatchEvent → XACK
 *   - reliability: a poison entry → DLQ + ACK; a handler that keeps
 *     throwing → reclaimed by XAUTOCLAIM and eventually DLQ'd, never
 *     redelivered forever.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  StreamsConsumer,
  findGroupInfo,
  groupNameFor,
  type RedisStreamsLike,
} from "../src/streams-consumer.js";
import { pluginDlqKeyFor, pluginStreamKeyFor } from "../src/streams-protocol.js";

const silentLog = {
  info() {},
  warn() {},
  error() {},
};

interface StreamEntry {
  id: string;
  fields: string[];
  deliveries: number;
  acked: boolean;
  lastDeliveredAt: number;
}

/**
 * Minimal Streams-only fake. Tracks per-entry delivery count + ack state
 * so XREADGROUP / XAUTOCLAIM / XPENDING / XACK / XADD behave close enough
 * to Redis for the consumer's decision logic.
 */
class FakeRedis implements RedisStreamsLike {
  streams = new Map<string, StreamEntry[]>();
  groups = new Set<string>();
  private seq = 0;

  private ensure(key: string): StreamEntry[] {
    let s = this.streams.get(key);
    if (!s) {
      s = [];
      this.streams.set(key, s);
    }
    return s;
  }

  seed(key: string, fields: string[]): string {
    const id = `${++this.seq}-0`;
    this.ensure(key).push({
      id,
      fields,
      deliveries: 0,
      acked: false,
      lastDeliveredAt: 0,
    });
    return id;
  }

  async xgroup(...args: Array<string | number>): Promise<unknown> {
    const [, key, group] = args as [string, string, string];
    this.ensure(key);
    this.groups.add(`${key}::${group}`);
    return "OK";
  }

  async xreadgroup(...args: Array<string | number>): Promise<unknown> {
    // GROUP g c COUNT n BLOCK ms STREAMS k1 k2 > >
    const a = args.map(String);
    const countIdx = a.indexOf("COUNT");
    const count = countIdx >= 0 ? Number(a[countIdx + 1]) : 10;
    const streamsIdx = a.indexOf("STREAMS");
    const rest = a.slice(streamsIdx + 1);
    const keys = rest.slice(0, rest.length / 2);
    const out: Array<[string, Array<[string, string[]]>]> = [];
    for (const key of keys) {
      const fresh = this.ensure(key).filter(
        (e) => !e.acked && e.deliveries === 0,
      );
      const take = fresh.slice(0, count);
      if (take.length === 0) continue;
      const entries: Array<[string, string[]]> = [];
      for (const e of take) {
        e.deliveries += 1;
        e.lastDeliveredAt = Date.now();
        entries.push([e.id, e.fields]);
      }
      out.push([key, entries]);
    }
    return out.length > 0 ? out : null;
  }

  async xautoclaim(...args: Array<string | number>): Promise<unknown> {
    // key group consumer minIdle cursor COUNT n
    const [key, , , minIdle] = args as [string, string, string, number];
    const now = Date.now();
    const claimable = this.ensure(key).filter(
      (e) => !e.acked && e.deliveries > 0 && now - e.lastDeliveredAt >= minIdle,
    );
    const entries: Array<[string, string[]]> = [];
    for (const e of claimable) {
      e.deliveries += 1;
      e.lastDeliveredAt = now;
      entries.push([e.id, e.fields]);
    }
    return ["0-0", entries, []];
  }

  async xpending(...args: Array<string | number>): Promise<unknown> {
    // key group start end count
    const [key, , id] = args as [string, string, string];
    const e = this.ensure(key).find((x) => x.id === id && !x.acked);
    if (!e) return [];
    return [[e.id, "consumer", 0, e.deliveries]];
  }

  async xack(key: string, _group: string, ...ids: string[]): Promise<number> {
    let n = 0;
    for (const e of this.ensure(key)) {
      if (ids.includes(e.id) && !e.acked) {
        e.acked = true;
        n++;
      }
    }
    return n;
  }

  async xadd(key: string, ...args: Array<string | number>): Promise<unknown> {
    // `*` then field/value pairs
    const fields = args.slice(1).map(String);
    return this.seed(key, fields);
  }

  async xlen(key: string): Promise<number> {
    return this.ensure(key).length;
  }

  async xinfo(...args: Array<string | number>): Promise<unknown> {
    const [sub, key] = args as [string, string];
    if (sub !== "GROUPS") return [];
    const unacked = this.ensure(key).filter((e) => !e.acked).length;
    return [
      ["name", `kc-consumer:test`, "lag", unacked, "entries-read", 0],
    ];
  }

  async quit(): Promise<string> {
    return "OK";
  }
}

function poll<T>(fn: () => T | null, timeoutMs = 1000): Promise<T> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      const v = fn();
      if (v !== null && v !== undefined) return resolve(v);
      if (Date.now() - start > timeoutMs) return reject(new Error("poll timeout"));
      setTimeout(tick, 5);
    };
    tick();
  });
}

describe("StreamsConsumer happy path", () => {
  it("dispatches a fresh entry then ACKs it", async () => {
    const redis = new FakeRedis();
    const key = pluginStreamKeyFor("test");
    const seen: Array<{ type: string; data: unknown }> = [];
    const consumer = new StreamsConsumer({
      redis,
      pluginKey: "test",
      dispatchEvent: async (type, data) => {
        seen.push({ type, data });
      },
      log: silentLog,
      blockMs: 10,
    });
    await consumer.ensureGroups();
    assert.ok(redis.groups.has(`${key}::${groupNameFor("test")}`));
    redis.seed(key, ["type", "guild.message_create", "data", '{"hi":1}']);
    consumer.start();
    await poll(() => (seen.length > 0 ? seen[0] : null));
    assert.equal(seen[0].type, "guild.message_create");
    assert.deepEqual(seen[0].data, { hi: 1 });
    // ACK happened.
    await poll(() =>
      redis.streams.get(key)!.every((e) => e.acked) ? true : null,
    );
    await consumer.stop();
  });
});

describe("StreamsConsumer reliability", () => {
  it("routes a poison entry to the DLQ and ACKs the source", async () => {
    const redis = new FakeRedis();
    const key = pluginStreamKeyFor("test");
    const consumer = new StreamsConsumer({
      redis,
      pluginKey: "test",
      dispatchEvent: async () => {
        throw new Error("should not be called for poison");
      },
      log: silentLog,
      blockMs: 10,
    });
    await consumer.ensureGroups();
    // Malformed data → poison on first delivery.
    redis.seed(key, ["type", "guild.message_create", "data", "{broken"]);
    consumer.start();
    const dlq = pluginDlqKeyFor("test");
    await poll(() =>
      (redis.streams.get(dlq)?.length ?? 0) > 0 ? true : null,
    );
    // Source entry acked, DLQ entry carries the reason.
    assert.ok(redis.streams.get(key)!.every((e) => e.acked));
    const dlqEntry = redis.streams.get(dlq)![0];
    assert.ok(dlqEntry.fields.includes("dlq_reason"));
    await consumer.stop();
  });

  it("eventually dead-letters an entry whose handler keeps throwing", async () => {
    const redis = new FakeRedis();
    const key = pluginStreamKeyFor("test");
    let calls = 0;
    const consumer = new StreamsConsumer({
      redis,
      pluginKey: "test",
      dispatchEvent: async () => {
        calls++;
        throw new Error("always fails");
      },
      log: silentLog,
      blockMs: 10,
      maxDeliveries: 3,
      claimMinIdleMs: 0, // reclaim immediately
      sweepIntervalMs: 10,
    });
    await consumer.ensureGroups();
    redis.seed(key, ["type", "guild.message_create", "data", "{}"]);
    consumer.start();
    const dlq = pluginDlqKeyFor("test");
    await poll(
      () => ((redis.streams.get(dlq)?.length ?? 0) > 0 ? true : null),
      3000,
    );
    // Source acked, handler was retried but bounded (not infinite).
    assert.ok(redis.streams.get(key)!.every((e) => e.acked));
    assert.ok(calls >= 1);
    assert.ok(calls <= 4, `expected bounded retries, got ${calls}`);
    await consumer.stop();
  });
});

describe("StreamsConsumer telemetry callbacks (PR-1.3)", () => {
  it("reports consumer lag via onLag during the sweep", async () => {
    const redis = new FakeRedis();
    const key = pluginStreamKeyFor("test");
    const lags: number[] = [];
    // Handler never acks (always throws) so unacked entries accrue lag.
    const consumer = new StreamsConsumer({
      redis,
      pluginKey: "test",
      dispatchEvent: async () => {
        throw new Error("hold the entry unacked");
      },
      log: silentLog,
      blockMs: 10,
      claimMinIdleMs: 999_999, // don't reclaim/DLQ during this test
      sweepIntervalMs: 10,
      onLag: (lag) => lags.push(lag),
    });
    await consumer.ensureGroups();
    redis.seed(key, ["type", "guild.message_create", "data", "{}"]);
    consumer.start();
    await poll(() => (lags.some((l) => l >= 1) ? true : null), 2000);
    assert.ok(lags[lags.length - 1] >= 1);
    await consumer.stop();
  });

  it("fires onDeadLetter when an entry is poison", async () => {
    const redis = new FakeRedis();
    const key = pluginStreamKeyFor("test");
    const dlqs: Array<{ eventType: string; reason: string }> = [];
    const consumer = new StreamsConsumer({
      redis,
      pluginKey: "test",
      dispatchEvent: async () => {},
      log: silentLog,
      blockMs: 10,
      onDeadLetter: (eventType, reason) => dlqs.push({ eventType, reason }),
    });
    await consumer.ensureGroups();
    redis.seed(key, ["type", "guild.message_create", "data", "{broken"]);
    consumer.start();
    await poll(() => (dlqs.length > 0 ? true : null), 2000);
    // Poison entries can't be parsed, so the event type is unknown.
    assert.equal(dlqs[0].eventType, "unknown");
    assert.equal(dlqs[0].reason, "parse-failure");
    await consumer.stop();
  });
});

describe("findGroupInfo", () => {
  it("extracts lag + entries-read for the named group", () => {
    const groups = [
      ["name", "other", "lag", 9, "entries-read", 1],
      ["name", "mine", "lag", 4, "entries-read", 7],
    ];
    assert.deepEqual(findGroupInfo(groups, "mine"), {
      lag: 4,
      entriesRead: 7,
    });
  });
  it("returns nulls when the group is absent", () => {
    assert.deepEqual(findGroupInfo([], "mine"), {
      lag: null,
      entriesRead: null,
    });
  });
});

/**
 * PR-6.2 — Cross-service E2E smoke: bot producer → real Redis → SDK consumer.
 *
 * Exercises a REAL event round-trip across the two services' production
 * code over a REAL Redis, with no stubs on the transport:
 *
 *   bot   RedisStreamsPluginEventBus.dispatchToPlugin()
 *         (XADD karyl:plugin:<pluginKey>:events — the PM-8 mailbox)
 *   redis (real server)
 *   sdk   StreamsConsumer  (XREADGROUP → handler → XACK)
 *
 * This is the loop PR-1.1 closed; the harness proves the producer and
 * consumer agree on stream key, field layout, and ack semantics against
 * a live broker — the one thing pure unit tests with a Map-backed stub
 * cannot prove.
 *
 * GATED behind TEST_E2E_REDIS_URL so it never runs in the normal suite
 * (this dir is also outside the pnpm workspace, so `pnpm -r test` skips
 * it entirely). To run, see e2e/README.md.
 *
 * Status: harness is correct + gated + documented. NOT executed in this
 * environment (no Redis/docker available here).
 *
 * Implementation note: the two cross-package modules are pulled in via
 * dynamic `import()` with local structural types, NOT static imports.
 * The bot builds without declaration files (`build/*.js` only), so a
 * static import would leave tsc without types; dynamic import + a local
 * interface keeps this harness type-checkable on its own. ioredis is
 * likewise resolved at runtime from the hoisted root node_modules.
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REDIS_URL = process.env.TEST_E2E_REDIS_URL;

// ─── Minimal structural types for the dynamically-imported modules ──────────

interface EventBus {
  dispatchToPlugin(
    pluginId: number,
    pluginKey: string,
    eventType: string,
    data: unknown,
  ): void;
}
interface EventBusCtor {
  new (redis: unknown, opts?: { maxLen?: number }): EventBus;
}

interface Consumer {
  ensureGroups(): Promise<void>;
  start(): void;
  stop(): Promise<void>;
}
interface ConsumerCtor {
  new (opts: {
    redis: unknown;
    pluginKey: string;
    dispatchEvent: (type: string, data: unknown) => Promise<void>;
    log: { info(): void; warn(): void; error(): void };
    blockMs?: number;
    sweepIntervalMs?: number;
  }): Consumer;
}

interface RedisClient {
  del(...keys: string[]): Promise<number>;
  quit(): Promise<string>;
  xpending(...args: Array<string | number>): Promise<unknown>;
}
interface RedisCtor {
  new (url: string): RedisClient;
}

// Indirection so tsc does not try to statically resolve these specifiers
// (the bot build ships no .d.ts; ioredis lives in the hoisted root
// node_modules e2e has no symlink to). At runtime Node resolves them
// normally. Each result is cast to its local structural type.
//
// Resolution is anchored at the WORKSPACE ROOT (walked up from this
// compiled file), not relative to the dist layout — the original
// `../../packages/...` specifier silently assumed dist/ nesting depth
// and broke the first time the suite actually ran against a Redis.
function findRepoRoot(from: string): string {
  let dir = from;
  for (let i = 0; i < 10; i++) {
    if (existsSync(path.join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`pnpm-workspace.yaml not found above ${from}`);
}
const REPO = findRepoRoot(path.dirname(fileURLToPath(import.meta.url)));
const dynImport = (relPath: string): Promise<unknown> =>
  import(pathToFileURL(path.join(REPO, relPath)).href);

async function loadBotProducer(): Promise<EventBusCtor> {
  const mod = (await dynImport(
    "packages/bot/build/adapters/redis/plugin-event-bus.js",
  )) as { RedisStreamsPluginEventBus: EventBusCtor };
  return mod.RedisStreamsPluginEventBus;
}

async function loadSdkConsumer(): Promise<{
  StreamsConsumer: ConsumerCtor;
  groupNameFor: (pluginKey: string) => string;
}> {
  const mod = (await dynImport(
    "packages/plugin-sdk/dist/streams-consumer.js",
  )) as {
    StreamsConsumer: ConsumerCtor;
    groupNameFor: (pluginKey: string) => string;
  };
  return { StreamsConsumer: mod.StreamsConsumer, groupNameFor: mod.groupNameFor };
}

async function makeRedis(): Promise<RedisClient> {
  // Bare specifier — resolve from the hoisted root node_modules, not a
  // repo-root file path.
  const mod = (await import("ioredis")) as unknown as { Redis: RedisCtor };
  return new mod.Redis(REDIS_URL!);
}

const noopLog = { info() {}, warn() {}, error() {} };

(REDIS_URL ? describe : describe.skip)(
  "PR-6.2 streams round-trip over real Redis",
  () => {
    const pluginKey = `e2e-${process.pid}`;
    const EVENT_TYPE = `e2e.message_create.${process.pid}`;
    // PM-8: per-plugin mailbox stream — must match both the bot producer
    // and the SDK's pluginStreamKeyFor convention.
    const STREAM_KEY = `karyl:plugin:${pluginKey}:events`;
    let producerRedis: RedisClient;
    let consumerRedis: RedisClient;
    let consumer: Consumer;
    let groupNameFor: (k: string) => string;
    let EventBusClass: EventBusCtor;
    const received: Array<{ type: string; data: unknown }> = [];

    before(async () => {
      EventBusClass = await loadBotProducer();
      const sdk = await loadSdkConsumer();
      groupNameFor = sdk.groupNameFor;

      producerRedis = await makeRedis();
      consumerRedis = await makeRedis();
      await producerRedis.del(STREAM_KEY).catch(() => 0);

      consumer = new sdk.StreamsConsumer({
        redis: consumerRedis,
        pluginKey,
        dispatchEvent: async (type, data) => {
          received.push({ type, data });
        },
        log: noopLog,
        blockMs: 200,
        sweepIntervalMs: 1_000,
      });
      await consumer.ensureGroups();
      consumer.start();
    });

    after(async () => {
      await consumer?.stop();
      await producerRedis?.del(STREAM_KEY).catch(() => 0);
      await producerRedis?.quit().catch(() => undefined);
      await consumerRedis?.quit().catch(() => undefined);
    });

    it("delivers a produced event to the SDK consumer and acks it", async () => {
      const bus = new EventBusClass(producerRedis);
      const payload = { id: "42", content: "hello e2e" };
      bus.dispatchToPlugin(1, pluginKey, EVENT_TYPE, payload);

      const deadline = Date.now() + 10_000;
      while (received.length === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
      }

      assert.equal(
        received.length,
        1,
        "consumer should receive exactly one event",
      );
      assert.equal(received[0].type, EVENT_TYPE);
      assert.deepEqual(received[0].data, payload);

      // After a successful handler the entry must be XACKed — the group's
      // pending summary count should be 0 (no redelivery owed).
      const pending = (await consumerRedis.xpending(
        STREAM_KEY,
        groupNameFor(pluginKey),
      )) as unknown[];
      assert.equal(pending[0], 0, "no entries should remain pending after ack");
    });
  },
);

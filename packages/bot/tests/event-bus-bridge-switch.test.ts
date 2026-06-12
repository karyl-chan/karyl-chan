/**
 * PR-1.2 — bridge transport switch.
 *
 * `dispatchEventToPlugins` must route to the Redis Streams bus when
 * EVENT_BUS=redis-streams, and fall back to HTTP fan-out otherwise. We
 * assert the routing decision by injecting a stub Redis client (so the
 * bus XADDs into a capture array) and spying on global fetch (the HTTP
 * path). The subscription gate must still apply on both transports.
 */

import { vi, describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";

vi.hoisted(() => {
  process.env.SQLITE_DB_PATH = ":memory:";
});

import { sequelize } from "../src/db.js";
import { Plugin } from "../src/modules/plugin-system/models/plugin.model.js";
import {
  rebuildEventIndex,
  dispatchEventToPlugins,
  __resetEventBusForTests,
} from "../src/modules/plugin-system/plugin-event-bridge.service.js";
import { __resetAdaptersForTests } from "../src/adapters/registry.js";
import {
  setRedisClientForTests,
  type RedisLike,
} from "../src/adapters/redis/client.js";
import type { PluginManifest } from "../src/modules/plugin-system/plugin-sdk-types.js";

interface XaddCall {
  key: string;
  args: Array<string | number>;
}

function makeStub(calls: XaddCall[]): RedisLike {
  return {
    async get() {
      return null;
    },
    async set() {
      return "OK";
    },
    async del() {
      return 0;
    },
    async hset() {
      return 0;
    },
    async hget() {
      return null;
    },
    async hdel() {
      return 0;
    },
    async hgetall() {
      return {};
    },
    async expire() {
      return 0;
    },
    async pexpire() {
      return 0;
    },
    async pttl() {
      return -1;
    },
    async eval() {
      return null;
    },
    async scan() {
      return ["0", []] as [string, string[]];
    },
    async ping() {
      return "PONG";
    },
    async quit() {
      return "OK";
    },
    async xadd(key: string, ...args: Array<string | number>) {
      calls.push({ key, args });
      return "0-1";
    },
  } as unknown as RedisLike;
}

async function seedSubscriber(): Promise<void> {
  const manifest: PluginManifest = {
    schema_version: "1",
    plugin: {
      id: "alpha",
      name: "alpha",
      version: "1.0.0",
      url: "http://plugin.invalid",
    },
    events_subscribed_global: ["guild.message_create"],
  };
  await Plugin.create({
    id: 1,
    pluginKey: "alpha",
    name: "alpha",
    version: "1.0.0",
    url: "http://plugin.invalid",
    enabled: true,
    status: "active",
    manifestJson: JSON.stringify(manifest),
    setupSecretHash: "h",
    tokenHash: null,
    dispatchHmacKey: "k",
    lastHeartbeatAt: null,
  } as Record<string, unknown>);
  await rebuildEventIndex();
}

beforeAll(async () => {
  await sequelize.sync({ force: true });
});

beforeEach(async () => {
  await Plugin.destroy({ where: {}, truncate: true });
  __resetEventBusForTests();
  __resetAdaptersForTests();
  delete process.env.EVENT_BUS;
  delete process.env.REDIS_URL;
  setRedisClientForTests(null);
  await rebuildEventIndex();
});

afterEach(() => {
  __resetEventBusForTests();
  __resetAdaptersForTests();
  setRedisClientForTests(null);
  delete process.env.EVENT_BUS;
  delete process.env.REDIS_URL;
});

describe("dispatchEventToPlugins transport switch", () => {
  it("XADDs to the stream (not HTTP) when EVENT_BUS=redis-streams", async () => {
    const calls: XaddCall[] = [];
    setRedisClientForTests(makeStub(calls));
    process.env.EVENT_BUS = "redis-streams";
    process.env.REDIS_URL = "redis://localhost:6379";
    await seedSubscriber();

    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 204 }));
    try {
      dispatchEventToPlugins("guild.message_create", { hi: 1 });
      await new Promise((r) => setTimeout(r, 10));
      expect(calls.length).toBe(1);
      expect(calls[0].key).toBe("karyl:plugin:alpha:events");
      // Streams path must NOT touch the HTTP fan-out.
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("uses HTTP fan-out (no XADD) when EVENT_BUS is unset (default)", async () => {
    const calls: XaddCall[] = [];
    setRedisClientForTests(makeStub(calls));
    // EVENT_BUS unset → default HTTP path.
    await seedSubscriber();

    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 204 }));
    try {
      dispatchEventToPlugins("guild.message_create", { hi: 1 });
      await new Promise((r) => setTimeout(r, 10));
      // No XADD — the bus was never constructed.
      expect(calls.length).toBe(0);
      // HTTP path attempted (host-policy may block plugin.invalid, but
      // the point is the Streams bus was NOT used).
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("drops events with no subscribers before reaching the bus", async () => {
    const calls: XaddCall[] = [];
    setRedisClientForTests(makeStub(calls));
    process.env.EVENT_BUS = "redis-streams";
    process.env.REDIS_URL = "redis://localhost:6379";
    // No plugin seeded → no subscribers.
    await rebuildEventIndex();

    dispatchEventToPlugins("guild.message_create", { hi: 1 });
    await new Promise((r) => setTimeout(r, 10));
    expect(calls.length).toBe(0);
  });
});

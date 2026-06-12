/**
 * RedisStreamsPluginEventBus producer.
 *
 * The bus is fire-and-forget; we capture XADD calls via a stub
 * that exposes an `xadd` method (the RedisLike interface doesn't
 * list xadd because nothing else uses it, but the stub still
 * implements it).
 */

import { describe, expect, it } from "vitest";
import { RedisStreamsPluginEventBus } from "../src/adapters/redis/plugin-event-bus.js";
import type { RedisLike } from "../src/adapters/redis/client.js";

interface XaddCall {
  key: string;
  args: Array<string | number>;
}

function makeStub(): { client: RedisLike; calls: XaddCall[] } {
  const calls: XaddCall[] = [];
  const client = {
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
      return ["0" as const, []] as [string, string[]];
    },
    async ping() {
      return "PONG";
    },
    async quit() {
      return "OK";
    },
    async xadd(
      this: void,
      key: string,
      ...args: Array<string | number>
    ): Promise<unknown> {
      calls.push({ key, args });
      return "0-1";
    },
  } as unknown as RedisLike;
  return { client, calls };
}

describe("RedisStreamsPluginEventBus", () => {
  it("XADDs to the plugin's mailbox stream key with bounded MAXLEN", async () => {
    const { client, calls } = makeStub();
    const bus = new RedisStreamsPluginEventBus(client, { maxLen: 1234 });
    bus.dispatchToPlugin(1, "my-plugin", "guild.message_create", { foo: "bar" });
    await new Promise((r) => setTimeout(r, 5));
    expect(calls.length).toBe(1);
    expect(calls[0].key).toBe("karyl:plugin:my-plugin:events");
    // MAXLEN ~ 1234 should be at the front of the args.
    expect(calls[0].args[0]).toBe("MAXLEN");
    expect(calls[0].args[1]).toBe("~");
    expect(calls[0].args[2]).toBe(1234);
    // Followed by the `*` id marker so Redis auto-assigns the entry id.
    expect(calls[0].args[3]).toBe("*");
  });

  it("payload includes type / data / traceparent fields", async () => {
    const { client, calls } = makeStub();
    const bus = new RedisStreamsPluginEventBus(client);
    bus.dispatchToPlugin(1, "my-plugin", "guild.message_reaction_add", { msg: "x" });
    await new Promise((r) => setTimeout(r, 5));
    const args = calls[0].args;
    // After MAXLEN~N* there are name/value pairs. Build a map.
    const fields: Record<string, string> = {};
    for (let i = 4; i < args.length; i += 2) {
      fields[String(args[i])] = String(args[i + 1]);
    }
    expect(fields.type).toBe("guild.message_reaction_add");
    expect(JSON.parse(fields.data)).toEqual({ msg: "x" });
    expect(fields.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-(00|01)$/);
  });

  it("uses the default MAXLEN when no override is passed", async () => {
    const { client, calls } = makeStub();
    new RedisStreamsPluginEventBus(client).dispatchToPlugin(1, "p", "x", {});
    await new Promise((r) => setTimeout(r, 5));
    expect(calls[0].args[2]).toBe(100_000);
  });

  it("swallows XADD failures (fire-and-forget contract)", async () => {
    const client = {
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
      async xadd(): Promise<unknown> {
        throw new Error("redis dead");
      },
    } as unknown as RedisLike;
    const bus = new RedisStreamsPluginEventBus(client);
    // Should not throw — dispatch is fire-and-forget.
    expect(() => bus.dispatchToPlugin(1, "p", "x", {})).not.toThrow();
  });
});

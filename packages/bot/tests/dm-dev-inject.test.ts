import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Client } from "discord.js";
import { createWebServer } from "../src/modules/web-core/server.js";
import { InMemoryDmInbox } from "../src/modules/dm-inbox/dm-inbox.service.js";
import {
  dmEventBus,
  type DmEvent,
} from "../src/modules/dm-inbox/dm-event-bus.js";

const CHANNEL_ID = "900000000000000010";
const USER_ID = "900000000000000011";

function fakeBot(): Client {
  return {
    user: { id: "bot1" },
    channels: { fetch: async () => null },
    users: {
      fetch: async () => {
        throw new Error("not configured");
      },
    },
    isReady: () => true,
    guilds: { cache: { size: 0 } },
    uptime: 0,
  } as unknown as Client;
}

function injectBody(overrides: Record<string, unknown> = {}) {
  return {
    channelId: CHANNEL_ID,
    recipient: { id: USER_ID, username: "alice", globalName: "Alice" },
    message: { id: "900000000000000012", content: "hello inbox" },
    ...overrides,
  };
}

describe("POST /api/dm/dev/inject-message", () => {
  let server: FastifyInstance;
  let unsubscribe: (() => void) | null = null;

  afterEach(async () => {
    unsubscribe?.();
    unsubscribe = null;
    if (server) await server.close();
  });

  it("pushes a synthetic DM through recordActivity and the event bus", async () => {
    const inbox = new InMemoryDmInbox();
    server = await createWebServer({
      staticRoot: undefined,
      bot: fakeBot(),
      dmInbox: inbox,
    });
    await server.ready();

    // The route publishes on the singleton bus (same one the SSE stream
    // serves) — capture what a connected SSE client would see.
    const seen: DmEvent[] = [];
    unsubscribe = dmEventBus.subscribe((event) => seen.push(event));

    const response = await server.inject({
      method: "POST",
      url: "/api/dm/dev/inject-message",
      payload: injectBody(),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().channel.id).toBe(CHANNEL_ID);
    expect(response.json().message.content).toBe("hello inbox");

    // Persisted via the real store path…
    const channels = await server.inject({
      method: "GET",
      url: "/api/dm/channels",
    });
    const listed = channels.json().channels as Array<{ id: string }>;
    expect(listed.some((c) => c.id === CHANNEL_ID)).toBe(true);

    // …and announced in the gateway handler's exact event sequence.
    expect(seen.map((e) => e.type)).toEqual([
      "channel-touched",
      "message-created",
    ]);
    const created = seen[1] as Extract<DmEvent, { type: "message-created" }>;
    expect(created.channelId).toBe(CHANNEL_ID);
    expect(created.message.author.id).toBe(USER_ID);
    expect(created.message.author.bot).toBe(false);
  });

  it("rejects malformed payloads", async () => {
    server = await createWebServer({
      staticRoot: undefined,
      bot: fakeBot(),
      dmInbox: new InMemoryDmInbox(),
    });
    await server.ready();

    for (const payload of [
      injectBody({ channelId: "not-a-snowflake" }),
      injectBody({ recipient: { id: USER_ID } }),
      injectBody({ message: { id: "1" } }),
      {},
    ]) {
      const response = await server.inject({
        method: "POST",
        url: "/api/dm/dev/inject-message",
        payload,
      });
      expect(response.statusCode).toBe(400);
    }
  });

  it("is unreachable when auth is configured", async () => {
    server = await createWebServer({
      staticRoot: undefined,
      bot: fakeBot(),
      dmInbox: new InMemoryDmInbox(),
      ownerIds: ["900000000000000099"],
    });
    await server.ready();

    const response = await server.inject({
      method: "POST",
      url: "/api/dm/dev/inject-message",
      payload: injectBody(),
    });
    // The global auth hook 401s before the handler; the handler's own
    // authUserId !== "dev" check would 404 even if it were reached.
    expect(response.statusCode).toBe(401);
  });
});

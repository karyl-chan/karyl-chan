/**
 * BH-1 — audience group membership finally has a write path.
 *
 * Members are keyed by groupName (shared by every behavior carrying the
 * same audienceGroupName) and managed via
 * GET/PUT /api/behavior-groups/:groupName/members. The bot DM matcher
 * must honour the list as soon as it changes.
 */
import { vi, describe, it, expect, beforeAll, beforeEach } from "vitest";

vi.hoisted(() => {
  process.env.SQLITE_DB_PATH = ":memory:";
  process.env.ENCRYPTION_KEY = "a".repeat(64);
});

vi.mock("../src/modules/bot-events/bot-event-log.js", () => ({
  botEventLog: { record: vi.fn() },
}));

import Fastify, { type FastifyInstance } from "fastify";
import { sequelize } from "../src/db.js";
import { ChannelType } from "discord.js";
import { registerBehaviorRoutes } from "../src/modules/behavior/behavior-routes.js";
import { MessageTriggerMatcher } from "../src/modules/command-system/message-trigger-matcher.service.js";
import type { WebhookForwarder } from "../src/modules/command-system/webhook-forwarder.service.js";
import { clearBehaviors, seedMessageTrigger } from "./behavior-fixtures.js";

async function buildServer(): Promise<FastifyInstance> {
  const fastify = Fastify({ logger: false });
  fastify.addHook("onRequest", async (request) => {
    request.authUserId = "test";
    request.authCapabilities = new Set(["admin"]);
  });
  await registerBehaviorRoutes(fastify);
  await fastify.ready();
  return fastify;
}

beforeAll(async () => {
  await sequelize.sync({ force: true });
});

beforeEach(async () => {
  await clearBehaviors();
});

describe("behavior group members API", () => {
  it("PUT replaces the list and GET reads it back", async () => {
    const server = await buildServer();

    let res = await server.inject({
      method: "PUT",
      url: "/api/behavior-groups/vip/members",
      payload: { userIds: ["111111111", "222222222", "111111111"] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().members).toEqual(["111111111", "222222222"]);

    res = await server.inject({
      method: "GET",
      url: "/api/behavior-groups/vip/members",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      groupName: "vip",
      members: ["111111111", "222222222"],
    });

    // full replace: dropping a member really removes them
    res = await server.inject({
      method: "PUT",
      url: "/api/behavior-groups/vip/members",
      payload: { userIds: ["222222222"] },
    });
    expect(res.json().members).toEqual(["222222222"]);

    await server.close();
  });

  it("rejects non-snowflake user ids", async () => {
    const server = await buildServer();
    const res = await server.inject({
      method: "PUT",
      url: "/api/behavior-groups/vip/members",
      payload: { userIds: ["not-an-id"] },
    });
    expect(res.statusCode).toBe(400);
    await server.close();
  });

  it("the matcher honours a membership change right away", async () => {
    const id = await seedMessageTrigger({
      title: "vip-only",
      patternValue: "!vip",
      audienceKind: "group",
      audienceGroupName: "vip",
    });
    const forward = vi.fn(async () => ({ ok: true, relayContent: "" }));
    const matcher = new MessageTriggerMatcher({ forward } as unknown as WebhookForwarder);
    const dm = (userId: string) =>
      ({
        id: "M",
        content: "!vip",
        guildId: null,
        author: {
          id: userId,
          bot: false,
          username: "u",
          displayAvatarURL: () => "https://cdn.example/a.png",
        },
        client: { user: { id: "BOT" } },
        channel: { id: `DM-${userId}`, type: ChannelType.DM, send: vi.fn(async () => {}) },
      }) as never;

    // warm the trigger snapshot before the membership changes
    expect((await matcher.onMessage(dm("333333333"))).handled).toBe(false);

    const server = await buildServer();
    await server.inject({
      method: "PUT",
      url: "/api/behavior-groups/vip/members",
      payload: { userIds: ["333333333"] },
    });

    expect(await matcher.onMessage(dm("333333333"))).toEqual({ handled: true, behaviorId: id });
    expect((await matcher.onMessage(dm("444444444"))).handled).toBe(false);

    await server.close();
  });
});

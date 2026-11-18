/**
 * BH-1 — audience group membership finally has a write path.
 *
 * Members are keyed by groupName (shared by every behavior carrying the
 * same audienceGroupName) and managed via
 * GET/PUT /api/behavior-groups/:groupName/members. The bot DM matcher
 * must honour the list as soon as it changes.
 *
 * ADR 0004 (replacing #137): a group is a Behavior Target with a row of
 * its own — members can be set once it exists, with or without a trigger
 * using it, and stay until the group target is deleted.
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
import { listAudit } from "../src/modules/admin/admin-audit.service.js";
import { clearBehaviors, seedBehaviorTarget, seedMessageTrigger } from "./behavior-fixtures.js";

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

/** A group target and a bot DM trigger for it. */
async function useGroup(groupName: string, title = `uses ${groupName}`): Promise<number> {
  await seedBehaviorTarget(`group:${groupName}`).catch(() => undefined); // already there
  return seedMessageTrigger({ title, audienceKind: "group", audienceGroupName: groupName });
}

describe("behavior group members API", () => {
  it("PUT replaces the list and GET reads it back", async () => {
    await useGroup("vip");
    const server = await buildServer();

    let res = await server.inject({
      method: "PUT",
      url: "/api/behavior-groups/vip/members",
      payload: { userIds: ["111111111111111111", "222222222222222222", "111111111111111111"] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().members).toEqual(["111111111111111111", "222222222222222222"]);

    res = await server.inject({
      method: "GET",
      url: "/api/behavior-groups/vip/members",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      groupName: "vip",
      members: ["111111111111111111", "222222222222222222"],
    });

    // full replace: dropping a member really removes them
    res = await server.inject({
      method: "PUT",
      url: "/api/behavior-groups/vip/members",
      payload: { userIds: ["222222222222222222"] },
    });
    expect(res.json().members).toEqual(["222222222222222222"]);

    await server.close();
  });

  it("records the replacement in admin_audit_log", async () => {
    await useGroup("ops");
    const server = await buildServer();
    await server.inject({
      method: "PUT",
      url: "/api/behavior-groups/ops/members",
      payload: { userIds: ["555555555555555555"] },
    });
    const [entry] = await listAudit({ limit: 1 });
    expect(entry).toMatchObject({
      actorUserId: "test",
      action: "behavior.group_members.replace",
      target: "group:ops",
      context: { userIds: ["555555555555555555"] },
    });
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
    await seedBehaviorTarget("group:vip");
    const id = await seedMessageTrigger({
      title: "vip-only",
      patternValue: "!vip",
      audienceKind: "group",
      audienceGroupName: "vip",
    });
    const forward = vi.fn(async () => ({ ok: true, reply: {}, notes: [] }));
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
    expect((await matcher.onMessage(dm("333333333333333333"))).handled).toBe(false);

    const server = await buildServer();
    await server.inject({
      method: "PUT",
      url: "/api/behavior-groups/vip/members",
      payload: { userIds: ["333333333333333333"] },
    });

    expect(await matcher.onMessage(dm("333333333333333333"))).toEqual({ handled: true, behaviorId: id });
    expect((await matcher.onMessage(dm("444444444444444444"))).handled).toBe(false);

    await server.close();
  });
});

describe("a group keeps its members until it is deleted", () => {
  const A = "111111111111111111";
  const B = "222222222222222222";

  async function members(server: FastifyInstance, groupName: string): Promise<string[]> {
    const res = await server.inject({ method: "GET", url: `/api/behavior-groups/${groupName}/members` });
    return res.json().members;
  }

  function setMembers(server: FastifyInstance, groupName: string, userIds: string[]) {
    return server.inject({
      method: "PUT",
      url: `/api/behavior-groups/${groupName}/members`,
      payload: { userIds },
    });
  }

  it("refuses members for a group that does not exist", async () => {
    await seedMessageTrigger({ title: "everyone" });
    const server = await buildServer();
    const res = await setMembers(server, "no-such-group", [A]);
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toMatchObject({ code: "not_found", field: "groupName" });
    expect(await members(server, "no-such-group")).toEqual([]);
    await server.close();
  });

  it("takes members with no trigger using it", async () => {
    await seedBehaviorTarget("group:spare");
    const server = await buildServer();
    expect((await setMembers(server, "spare", [A])).statusCode).toBe(200);
    expect(await members(server, "spare")).toEqual([A]);
    await server.close();
  });

  it("keeps the list when the last trigger moves to another audience", async () => {
    const first = await useGroup("vip", "first");
    const second = await useGroup("vip", "second");
    const server = await buildServer();
    await setMembers(server, "vip", [A, B]);

    await server.inject({ method: "PATCH", url: `/api/behaviors/${first}`, payload: { audienceKind: "all", audienceGroupName: null } });
    await server.inject({ method: "PATCH", url: `/api/behaviors/${second}`, payload: { audienceGroupName: "staff" } });
    expect(await members(server, "vip")).toEqual([A, B]);
    // the group the trigger moved to is registered by that write
    expect((await setMembers(server, "staff", [B])).statusCode).toBe(200);
    await server.close();
  });

  it("keeps the list when the last trigger using it is deleted", async () => {
    const id = await useGroup("vip");
    const server = await buildServer();
    await setMembers(server, "vip", [A]);
    const res = await server.inject({ method: "DELETE", url: `/api/behaviors/${id}` });
    expect(res.statusCode).toBe(204);
    expect(await members(server, "vip")).toEqual([A]);
    await server.close();
  });

  it("loses the list when the group target is deleted", async () => {
    const targetId = await seedBehaviorTarget("group:vip");
    const server = await buildServer();
    await setMembers(server, "vip", [A, B]);
    const res = await server.inject({ method: "DELETE", url: `/api/behavior-targets/${targetId}` });
    expect(res.statusCode).toBe(204);
    expect(await members(server, "vip")).toEqual([]);
    expect((await setMembers(server, "vip", [A])).statusCode).toBe(404);
    await server.close();
  });
});

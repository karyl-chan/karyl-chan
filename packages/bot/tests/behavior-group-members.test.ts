/**
 * BH-1 — audience group membership finally has a write path.
 *
 * Members are keyed by groupName (shared by every behavior carrying the
 * same audienceGroupName) and managed via
 * GET/PUT /api/behavior-groups/:groupName/members. The dispatch-side
 * filter (collectApplicableBehaviorsForUser) must honour the list.
 */
import { vi, describe, it, expect, beforeAll, beforeEach } from "vitest";

vi.hoisted(() => {
  process.env.SQLITE_DB_PATH = ":memory:";
  process.env.ENCRYPTION_KEY = "a".repeat(64);
});

import Fastify, { type FastifyInstance } from "fastify";
import { sequelize } from "../src/db.js";
import { Behavior } from "../src/modules/behavior/models/behavior.model.js";
import { registerBehaviorRoutes } from "../src/modules/behavior/behavior-routes.js";
import { collectApplicableBehaviorsForUser } from "../src/modules/command-system/message-pattern-matcher.service.js";
import { encryptSecret } from "../src/utils/crypto.js";

async function buildServer(): Promise<FastifyInstance> {
  const fastify = Fastify({ logger: false });
  fastify.addHook("onRequest", async (request) => {
    request.authUserId = "test";
    request.authCapabilities = new Set(["admin"]);
  });
  await registerBehaviorRoutes(fastify, {
    reconciler: { reconcileAll: async () => undefined } as never,
  });
  await fastify.ready();
  return fastify;
}

beforeAll(async () => {
  await sequelize.sync({ force: true });
});

beforeEach(async () => {
  await Behavior.destroy({ where: {} });
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

  it("dispatch-side audience filter honours group membership", async () => {
    await Behavior.create({
      id: 1,
      title: "vip-only",
      enabled: true,
      sortOrder: 0,
      stopOnMatch: false,
      forwardType: "one_time",
      source: "custom",
      triggerType: "message_pattern",
      messagePatternKind: "startswith",
      messagePatternValue: "!vip",
      scope: "global",
      integrationTypes: "guild_install,user_install",
      contexts: "BotDM",
      audienceKind: "group",
      audienceGroupName: "vip",
      webhookUrl: encryptSecret("https://example.test/hook"),
      scopeTabId: 1,
    } as Record<string, unknown>);

    const server = await buildServer();
    await server.inject({
      method: "PUT",
      url: "/api/behavior-groups/vip/members",
      payload: { userIds: ["333333333"] },
    });

    const forMember = await collectApplicableBehaviorsForUser("333333333");
    expect(forMember.map((b) => b.id)).toEqual([1]);

    const forOutsider = await collectApplicableBehaviorsForUser("444444444");
    expect(forOutsider).toEqual([]);

    await server.close();
  });
});

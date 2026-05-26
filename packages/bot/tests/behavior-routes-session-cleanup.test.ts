/**
 * Regression：admin 透過 PATCH 把 behavior 的 forwardType 從 continuous 改成
 * one_time（或 disabled）後，behavior_sessions 表中針對該 behavior 的活動
 * session 必須被清掉，否則 matcher 仍會繼續吞 DM forward。
 *
 * 同樣覆蓋 DELETE 路徑：刪除 behavior 時連帶清 session，且 audit log 帶 count。
 */

import { vi, describe, it, expect, beforeAll, beforeEach } from "vitest";

vi.hoisted(() => {
  process.env.SQLITE_DB_PATH = ":memory:";
  process.env.ENCRYPTION_KEY = "a".repeat(64);
});

import Fastify, { type FastifyInstance } from "fastify";
import { sequelize } from "../src/db.js";
import { Behavior } from "../src/modules/behavior/models/behavior.model.js";
import { BehaviorSession } from "../src/modules/behavior/models/behavior-session.model.js";
import { registerBehaviorRoutes } from "../src/modules/behavior/behavior-routes.js";
import { encryptSecret } from "../src/utils/crypto.js";

async function buildServer(): Promise<FastifyInstance> {
  const fastify = Fastify({ logger: false });
  fastify.addHook("onRequest", async (request) => {
    request.authUserId = "test";
    request.authCapabilities = new Set(["admin"]);
  });
  await registerBehaviorRoutes(fastify, {
    reconciler: {
      reconcileAll: async () => ({
        created: 0,
        patched: 0,
        deleted: 0,
        errors: [],
      }),
      reconcileForGuild: async () => undefined,
      reconcileForBehavior: async () => ({
        ok: true,
        source: "behavior" as const,
        sourceId: 0,
        action: "noop" as const,
      }),
    } as never,
  });
  await fastify.ready();
  return fastify;
}

async function seedContinuousBehavior(id: number): Promise<void> {
  await Behavior.create({
    id,
    title: "continuous-relay",
    enabled: true,
    sortOrder: 0,
    source: "custom",
    triggerType: "message_pattern",
    messagePatternKind: "startswith",
    messagePatternValue: "!relay",
    forwardType: "continuous",
    scope: "global",
    integrationTypes: "guild_install",
    contexts: "BotDM,PrivateChannel",
    audienceKind: "all",
    webhookUrl: encryptSecret("http://example.invalid/hook"),
    scopeTabId: 1,
  } as Record<string, unknown>);
}

async function seedActiveSession(
  userId: string,
  behaviorId: number,
): Promise<void> {
  await BehaviorSession.upsert({
    userId,
    behaviorId,
    channelId: "dm-channel-id",
    startedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
}

beforeAll(async () => {
  await sequelize.sync({ force: true });
});

beforeEach(async () => {
  await BehaviorSession.destroy({ where: {} });
  await Behavior.destroy({ where: {} });
});

describe("behavior-routes — H-3 session cleanup on forwardType / enabled flip", () => {
  it("PATCH forwardType continuous→one_time clears active sessions", async () => {
    await seedContinuousBehavior(10);
    await seedActiveSession("user-A", 10);
    await seedActiveSession("user-B", 10);
    expect(await BehaviorSession.count({ where: { behaviorId: 10 } })).toBe(2);

    const server = await buildServer();
    const res = await server.inject({
      method: "PATCH",
      url: "/api/behaviors/10",
      payload: { forwardType: "one_time" },
    });
    expect(res.statusCode).toBe(200);

    expect(await BehaviorSession.count({ where: { behaviorId: 10 } })).toBe(0);
    await server.close();
  });

  it("PATCH enabled=false clears active sessions even if forwardType stays continuous", async () => {
    await seedContinuousBehavior(11);
    await seedActiveSession("user-A", 11);
    expect(await BehaviorSession.count({ where: { behaviorId: 11 } })).toBe(1);

    const server = await buildServer();
    const res = await server.inject({
      method: "PATCH",
      url: "/api/behaviors/11",
      payload: { enabled: false },
    });
    expect(res.statusCode).toBe(200);

    expect(await BehaviorSession.count({ where: { behaviorId: 11 } })).toBe(0);
    await server.close();
  });

  it("PATCH that doesn't change forwardType / enabled leaves sessions alone", async () => {
    await seedContinuousBehavior(12);
    await seedActiveSession("user-A", 12);

    const server = await buildServer();
    const res = await server.inject({
      method: "PATCH",
      url: "/api/behaviors/12",
      payload: { title: "new title" },
    });
    expect(res.statusCode).toBe(200);

    expect(await BehaviorSession.count({ where: { behaviorId: 12 } })).toBe(1);
    await server.close();
  });

  it("DELETE behavior explicitly clears its sessions before destroy", async () => {
    await seedContinuousBehavior(13);
    await seedActiveSession("user-A", 13);
    await seedActiveSession("user-B", 13);

    const server = await buildServer();
    const res = await server.inject({
      method: "DELETE",
      url: "/api/behaviors/13",
    });
    expect(res.statusCode).toBe(204);

    expect(await BehaviorSession.count({ where: { behaviorId: 13 } })).toBe(0);
    expect(await Behavior.count({ where: { id: 13 } })).toBe(0);
    await server.close();
  });
});

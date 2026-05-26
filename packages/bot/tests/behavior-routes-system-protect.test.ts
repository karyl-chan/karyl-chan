/**
 * admin-login 與 break 是 admin 進後台 / 收尾 session 的唯一逃生口，停用後
 * 找不回；後端 PATCH 必須在 systemKey 屬於 protected set 時回 403。
 * manual 可關（語意：失去 DM 行為列表助理但其他功能不影響）。
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

async function seedSystemRow(
  id: number,
  systemKey: "admin-login" | "manual" | "break",
  slashCommandName: string,
): Promise<void> {
  await Behavior.create({
    id,
    title: systemKey,
    enabled: true,
    sortOrder: 0,
    stopOnMatch: true,
    forwardType: "one_time",
    source: "system",
    triggerType: "slash_command",
    slashCommandName,
    slashCommandDescription: systemKey,
    scope: "global",
    integrationTypes: "guild_install,user_install",
    contexts: "BotDM",
    audienceKind: "all",
    systemKey,
    scopeTabId: 1,
  } as Record<string, unknown>);
}

beforeAll(async () => {
  await sequelize.sync({ force: true });
});

beforeEach(async () => {
  await Behavior.destroy({ where: {} });
});

describe("behavior-routes — system disable protection", () => {
  it("PATCH enabled=false on admin-login → 403", async () => {
    await seedSystemRow(1, "admin-login", "login");
    const server = await buildServer();
    const res = await server.inject({
      method: "PATCH",
      url: "/api/behaviors/1",
      payload: { enabled: false },
    });
    expect(res.statusCode).toBe(403);
    const row = await Behavior.findByPk(1);
    expect(row?.getDataValue("enabled")).toBe(true);
    await server.close();
  });

  it("PATCH enabled=false on break → 403", async () => {
    await seedSystemRow(2, "break", "break");
    const server = await buildServer();
    const res = await server.inject({
      method: "PATCH",
      url: "/api/behaviors/2",
      payload: { enabled: false },
    });
    expect(res.statusCode).toBe(403);
    const row = await Behavior.findByPk(2);
    expect(row?.getDataValue("enabled")).toBe(true);
    await server.close();
  });

  it("PATCH enabled=false on manual → 200", async () => {
    await seedSystemRow(3, "manual", "manual");
    const server = await buildServer();
    const res = await server.inject({
      method: "PATCH",
      url: "/api/behaviors/3",
      payload: { enabled: false },
    });
    expect(res.statusCode).toBe(200);
    const row = await Behavior.findByPk(3);
    expect(row?.getDataValue("enabled")).toBe(false);
    await server.close();
  });

  it("PATCH enabled=true on a disabled manual → 200 (re-enable allowed)", async () => {
    await seedSystemRow(4, "manual", "manual");
    await Behavior.update({ enabled: false }, { where: { id: 4 } });
    const server = await buildServer();
    const res = await server.inject({
      method: "PATCH",
      url: "/api/behaviors/4",
      payload: { enabled: true },
    });
    expect(res.statusCode).toBe(200);
    const row = await Behavior.findByPk(4);
    expect(row?.getDataValue("enabled")).toBe(true);
    await server.close();
  });

  it("PATCH enabled=true on admin-login is NOT blocked (re-enable is always allowed)", async () => {
    await seedSystemRow(5, "admin-login", "login");
    await Behavior.update({ enabled: false }, { where: { id: 5 } });
    const server = await buildServer();
    const res = await server.inject({
      method: "PATCH",
      url: "/api/behaviors/5",
      payload: { enabled: true },
    });
    expect(res.statusCode).toBe(200);
    const row = await Behavior.findByPk(5);
    expect(row?.getDataValue("enabled")).toBe(true);
    await server.close();
  });
});

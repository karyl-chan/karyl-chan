/**
 * BH-0.2 — integrationTypes is a slash-command install-surface setting; a
 * message_pattern behavior never goes through Discord command registration,
 * so accepting the field there stores a value that can never take effect.
 * PATCH must reject it (400) for pattern behaviors while keeping the
 * global_all slash flow working.
 */
import { vi, describe, it, expect, beforeAll, beforeEach } from "vitest";

vi.hoisted(() => {
  process.env.SQLITE_DB_PATH = ":memory:";
  process.env.ENCRYPTION_KEY = "a".repeat(64);
});

import Fastify, { type FastifyInstance } from "fastify";
import { sequelize } from "../src/db.js";
import { Behavior } from "../src/modules/behavior/models/behavior.model.js";
import { BehaviorScopeTab } from "../src/modules/behavior/models/behavior-scope-tab.model.js";
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
      reconcileAll: async () => ({ created: 0, patched: 0, deleted: 0, errors: [] }),
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

const BASE = {
  enabled: true,
  sortOrder: 0,
  stopOnMatch: false,
  forwardType: "one_time",
  source: "custom",
  webhookUrl: encryptSecret("https://example.test/hook"),
  scope: "global",
  integrationTypes: "guild_install,user_install",
  contexts: "BotDM",
  audienceKind: "all",
  scopeTabId: 1,
} as const;

beforeAll(async () => {
  await sequelize.sync({ force: true });
  await BehaviorScopeTab.create({
    id: 1,
    tabType: "global_all",
    label: "All",
    sortOrder: 0,
  } as Record<string, unknown>);
});

beforeEach(async () => {
  await Behavior.destroy({ where: {} });
});

describe("PATCH /api/behaviors/:id — integrationTypes vs triggerType", () => {
  it("rejects integrationTypes on a message_pattern behavior (400)", async () => {
    await Behavior.create({
      id: 1,
      title: "pattern",
      triggerType: "message_pattern",
      messagePatternKind: "startswith",
      messagePatternValue: "!hi",
      ...BASE,
    } as Record<string, unknown>);
    const server = await buildServer();
    const res = await server.inject({
      method: "PATCH",
      url: "/api/behaviors/1",
      payload: { integrationTypes: "guild_install" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("integrationTypes");
    await server.close();
  });

  it("still accepts integrationTypes on a slash behavior on global_all (200)", async () => {
    await Behavior.create({
      id: 2,
      title: "slash",
      triggerType: "slash_command",
      slashCommandName: "deploy",
      slashCommandDescription: "d",
      ...BASE,
    } as Record<string, unknown>);
    const server = await buildServer();
    const res = await server.inject({
      method: "PATCH",
      url: "/api/behaviors/2",
      payload: { integrationTypes: "guild_install" },
    });
    expect(res.statusCode).toBe(200);
    const row = await Behavior.findByPk(2);
    expect(row?.getDataValue("integrationTypes")).toBe("guild_install");
    await server.close();
  });

  it("accepts integrationTypes when the same PATCH switches pattern → slash", async () => {
    await Behavior.create({
      id: 3,
      title: "pattern-to-slash",
      triggerType: "message_pattern",
      messagePatternKind: "startswith",
      messagePatternValue: "!hi",
      ...BASE,
    } as Record<string, unknown>);
    const server = await buildServer();
    const res = await server.inject({
      method: "PATCH",
      url: "/api/behaviors/3",
      payload: {
        triggerType: "slash_command",
        slashCommandName: "switched",
        integrationTypes: "guild_install",
      },
    });
    expect(res.statusCode).toBe(200);
    await server.close();
  });
});

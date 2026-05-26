/**
 * Regression：admin 透過 PATCH /api/behaviors/:id 把 triggerType 從
 * slash_command 切到 message_pattern 後，Discord 端的舊 /command 沒被清掉。
 *
 * 修法是讓 POST / PATCH / DELETE 三條路徑都 fire-and-forget 呼叫
 * reconciler.reconcileAll() —— 它的 stale-cleanup 步驟會處理舊指令。
 * 這支測試只驗證「成功路徑會排程一次 reconcileAll」，不模擬整段 Discord 流程。
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
import { encryptSecret } from "../src/utils/crypto.js";

interface ReconcilerSpy {
  reconcileAll: ReturnType<typeof vi.fn>;
  reconcileForGuild: ReturnType<typeof vi.fn>;
  reconcileForBehavior: ReturnType<typeof vi.fn>;
}

function buildReconcilerSpy(): ReconcilerSpy {
  return {
    reconcileAll: vi.fn(async () => ({
      created: 0,
      patched: 0,
      deleted: 0,
      errors: [],
    })),
    reconcileForGuild: vi.fn(async () => undefined),
    reconcileForBehavior: vi.fn(async () => ({
      ok: true,
      source: "behavior" as const,
      sourceId: 0,
      action: "noop" as const,
    })),
  };
}

async function buildServer(spy: ReconcilerSpy): Promise<FastifyInstance> {
  const fastify = Fastify({ logger: false });
  fastify.addHook("onRequest", async (request) => {
    request.authUserId = "test";
    request.authCapabilities = new Set(["admin"]);
  });
  await registerBehaviorRoutes(fastify, {
    reconciler: spy as never,
  });
  await fastify.ready();
  return fastify;
}

async function flushFireAndForget(): Promise<void> {
  // scheduleReconcileAfterMutation 不 await reconcileAll；用 microtask flush
  // 等它完成,避免測試在 promise resolve 前就 assert。
  await new Promise<void>((r) => setImmediate(r));
  await new Promise<void>((r) => setImmediate(r));
}

beforeAll(async () => {
  await sequelize.sync({ force: true });
});

beforeEach(async () => {
  await Behavior.destroy({ where: {} });
});

describe("behavior-routes — reconcileAll fire-and-forget after CRUD", () => {
  it("PATCH custom behavior triggers reconcileAll", async () => {
    await Behavior.create({
      id: 1,
      title: "ping",
      enabled: true,
      sortOrder: 0,
      source: "custom",
      triggerType: "slash_command",
      slashCommandName: "ping",
      slashCommandDescription: "ping",
      scope: "global",
      integrationTypes: "guild_install",
      contexts: "BotDM",
      audienceKind: "all",
      webhookUrl: encryptSecret("http://example.invalid/hook"),
      scopeTabId: 1,
    } as Record<string, unknown>);

    const spy = buildReconcilerSpy();
    const server = await buildServer(spy);

    const res = await server.inject({
      method: "PATCH",
      url: "/api/behaviors/1",
      payload: {
        triggerType: "message_pattern",
        messagePatternKind: "startswith",
        messagePatternValue: "!ping",
        slashCommandName: null,
      },
    });
    expect(res.statusCode).toBe(200);

    await flushFireAndForget();
    expect(spy.reconcileAll).toHaveBeenCalledTimes(1);

    await server.close();
  });

  it("PATCH system behavior (slash → message_pattern) triggers reconcileAll", async () => {
    await Behavior.create({
      id: 2,
      title: "manual",
      enabled: true,
      sortOrder: -999,
      stopOnMatch: true,
      forwardType: "one_time",
      source: "system",
      triggerType: "slash_command",
      slashCommandName: "manual",
      slashCommandDescription: "manual",
      scope: "global",
      integrationTypes: "guild_install,user_install",
      contexts: "BotDM",
      audienceKind: "all",
      systemKey: "manual",
      scopeTabId: 1,
    } as Record<string, unknown>);

    const spy = buildReconcilerSpy();
    const server = await buildServer(spy);

    const res = await server.inject({
      method: "PATCH",
      url: "/api/behaviors/2",
      payload: {
        triggerType: "message_pattern",
        messagePatternKind: "startswith",
        messagePatternValue: "?manual",
      },
    });
    expect(res.statusCode).toBe(200);

    await flushFireAndForget();
    expect(spy.reconcileAll).toHaveBeenCalledTimes(1);

    await server.close();
  });

  it("DELETE behavior triggers reconcileAll (clean up Discord registration)", async () => {
    await Behavior.create({
      id: 3,
      title: "to-delete",
      enabled: true,
      sortOrder: 0,
      source: "custom",
      triggerType: "slash_command",
      slashCommandName: "todelete",
      slashCommandDescription: "todelete",
      scope: "global",
      integrationTypes: "guild_install",
      contexts: "BotDM",
      audienceKind: "all",
      webhookUrl: encryptSecret("http://example.invalid/hook"),
      scopeTabId: 1,
    } as Record<string, unknown>);

    const spy = buildReconcilerSpy();
    const server = await buildServer(spy);

    const res = await server.inject({
      method: "DELETE",
      url: "/api/behaviors/3",
    });
    expect(res.statusCode).toBe(204);

    await flushFireAndForget();
    expect(spy.reconcileAll).toHaveBeenCalledTimes(1);

    await server.close();
  });
});

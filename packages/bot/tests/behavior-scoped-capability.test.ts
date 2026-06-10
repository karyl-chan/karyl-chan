/**
 * BH-5 — behavior:<scopeKey>.manage scoped delegation, finally enforced.
 *
 * A user holding only `behavior:guild:G1.manage` can list/CRUD behaviors
 * under the matching specific_guild tab and nothing else; the tab list
 * is filtered; group member management needs the matching group token;
 * tab CRUD and reorder stay global-only.
 */
import { vi, describe, it, expect, beforeAll } from "vitest";

vi.hoisted(() => {
  process.env.SQLITE_DB_PATH = ":memory:";
  process.env.ENCRYPTION_KEY = "a".repeat(64);
});

vi.mock("../src/utils/host-policy.js", async (importOriginal) => {
  const mod = (await importOriginal()) as Record<string, unknown>;
  return { ...mod, assertExternalTarget: vi.fn(async () => {}) };
});

import Fastify, { type FastifyInstance } from "fastify";
import { sequelize } from "../src/db.js";
import { Behavior } from "../src/modules/behavior/models/behavior.model.js";
import { BehaviorScopeTab } from "../src/modules/behavior/models/behavior-scope-tab.model.js";
import { registerBehaviorRoutes } from "../src/modules/behavior/behavior-routes.js";
import { registerScopeTabRoutes } from "../src/modules/behavior/scope-tab-routes.js";
import { encryptSecret } from "../src/utils/crypto.js";

async function buildServer(caps: string[]): Promise<FastifyInstance> {
  const fastify = Fastify({ logger: false });
  fastify.addHook("onRequest", async (request) => {
    request.authUserId = "scoped-user";
    request.authCapabilities = new Set(caps) as never;
  });
  await registerBehaviorRoutes(fastify, {
    reconciler: {
      reconcileAll: async () => undefined,
      reconcileForBehavior: async () => ({
        ok: true,
        source: "behavior" as const,
        sourceId: 0,
        action: "noop" as const,
      }),
    } as never,
  });
  await registerScopeTabRoutes(fastify);
  await fastify.ready();
  return fastify;
}

const BASE = {
  enabled: true,
  sortOrder: 0,
  stopOnMatch: false,
  ignoreBots: true,
  forwardType: "one_time",
  source: "custom",
  triggerType: "message_pattern",
  messagePatternKind: "startswith",
  webhookUrl: encryptSecret("https://example.test/hook"),
  audienceKind: "all",
} as const;

beforeAll(async () => {
  await sequelize.sync({ force: true });
  await BehaviorScopeTab.bulkCreate([
    { id: 1, tabType: "global_all", label: "All", sortOrder: 0 },
    { id: 5, tabType: "specific_guild", label: "G1", guildId: "G1", sortOrder: 1 },
    { id: 6, tabType: "specific_group", label: "vip", groupName: "vip", sortOrder: 2 },
  ] as Record<string, unknown>[]);
  await Behavior.bulkCreate([
    {
      id: 1,
      title: "global-row",
      messagePatternValue: "!a",
      scope: "global",
      integrationTypes: "guild_install,user_install",
      contexts: "BotDM",
      scopeTabId: 1,
      ...BASE,
    },
    {
      id: 2,
      title: "g1-row",
      messagePatternValue: "!b",
      scope: "guild",
      integrationTypes: "guild_install",
      contexts: "Guild",
      placementGuildId: "G1",
      scopeTabId: 5,
      ...BASE,
    },
  ] as Record<string, unknown>[]);
});

const SCOPED = ["behavior:guild:G1.manage"];

describe("BH-5 scoped behavior delegation", () => {
  it("filters the behavior list and tab list to the held scope", async () => {
    const server = await buildServer(SCOPED);
    const list = await server.inject({ method: "GET", url: "/api/behaviors" });
    expect(list.statusCode).toBe(200);
    expect(
      (list.json().behaviors as Array<{ id: number }>).map((b) => b.id),
    ).toEqual([2]);

    const tabs = await server.inject({ method: "GET", url: "/api/behavior-tabs" });
    expect(
      (tabs.json().tabs as Array<{ id: number }>).map((t) => t.id),
    ).toEqual([5]);
    await server.close();
  });

  it("allows CRUD inside the scope and 403s outside it", async () => {
    const server = await buildServer(SCOPED);

    // PATCH own-tab row
    let res = await server.inject({
      method: "PATCH",
      url: "/api/behaviors/2",
      payload: { title: "renamed by delegate" },
    });
    expect(res.statusCode).toBe(200);

    // PATCH other-tab row → 403
    res = await server.inject({
      method: "PATCH",
      url: "/api/behaviors/1",
      payload: { title: "nope" },
    });
    expect(res.statusCode).toBe(403);

    // POST into own tab → ok
    res = await server.inject({
      method: "POST",
      url: "/api/behaviors",
      payload: {
        title: "delegate-created",
        triggerType: "message_pattern",
        messagePatternKind: "startswith",
        messagePatternValue: "!new",
        webhookUrl: "https://example.test/hook2",
        scopeTabId: 5,
      },
    });
    expect(res.statusCode).toBe(201);

    // POST into global tab → 403
    res = await server.inject({
      method: "POST",
      url: "/api/behaviors",
      payload: {
        title: "nope",
        triggerType: "message_pattern",
        messagePatternKind: "startswith",
        messagePatternValue: "!x",
        webhookUrl: "https://example.test/hook3",
        scopeTabId: 1,
      },
    });
    expect(res.statusCode).toBe(403);

    // tab CRUD stays global-only
    res = await server.inject({
      method: "POST",
      url: "/api/behavior-tabs",
      payload: { tabType: "specific_guild", guildId: "G9", label: "G9" },
    });
    expect(res.statusCode).toBe(403);

    // reorder stays global-only
    res = await server.inject({
      method: "PATCH",
      url: "/api/behaviors/reorder",
      payload: { orderedIds: [2] },
    });
    expect(res.statusCode).toBe(403);
    await server.close();
  });

  it("group member management needs the matching group token", async () => {
    const noGroup = await buildServer(SCOPED);
    let res = await noGroup.inject({
      method: "PUT",
      url: "/api/behavior-groups/vip/members",
      payload: { userIds: ["123456789"] },
    });
    expect(res.statusCode).toBe(403);
    await noGroup.close();

    const withGroup = await buildServer(["behavior:group:vip.manage"]);
    res = await withGroup.inject({
      method: "PUT",
      url: "/api/behavior-groups/vip/members",
      payload: { userIds: ["123456789"] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().members).toEqual(["123456789"]);
    await withGroup.close();
  });

  it("a user with no behavior capability at all gets 403 on entry", async () => {
    const server = await buildServer(["system.read"]);
    const res = await server.inject({ method: "GET", url: "/api/behaviors" });
    expect(res.statusCode).toBe(403);
    await server.close();
  });
});

/**
 * #121 / #136 — PUT /api/behaviors/reorder orders the Message Triggers of
 * ONE Message Trigger Location (bot DMs, all guilds, one guild, one
 * channel). The triggers of other locations keep their places in the one
 * matching order, the System Behavior stays pinned, and a request based on
 * an outdated list of the location is refused.
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
import { registerBehaviorRoutes } from "../src/modules/behavior/behavior-routes.js";
import { loadBehaviorCatalog } from "../src/modules/behavior/behavior-catalog.js";
import { listAudit } from "../src/modules/admin/admin-audit.service.js";
import { clearBehaviors, seedMessageTrigger, seedSystemLogin } from "./behavior-fixtures.js";

const GUILD = "123456789012345678";
let server: FastifyInstance;

beforeAll(async () => {
  await sequelize.sync({ force: true });
  server = Fastify({ logger: false });
  server.addHook("onRequest", async (request) => {
    request.authUserId = "admin";
    request.authCapabilities = new Set(["behavior.manage"]) as never;
  });
  await registerBehaviorRoutes(server);
  await server.ready();
});

beforeEach(async () => {
  await clearBehaviors();
});

function reorder(location: string, ids: number[]) {
  return server.inject({
    method: "PUT",
    url: "/api/behaviors/reorder",
    payload: { location, ids },
  });
}

async function matchingOrder(): Promise<number[]> {
  const res = await server.inject({ method: "GET", url: "/api/behaviors" });
  return (res.json().messageTriggers as Array<{ id: number }>).map((t) => t.id);
}

const inGuild = { surface: "guild", guildId: GUILD };

describe("PUT /api/behaviors/reorder", () => {
  it("reorders one location and leaves the others where they were", async () => {
    const a = await seedMessageTrigger({ sortOrder: 0 });
    const x = await seedMessageTrigger({ sortOrder: 1, ...inGuild });
    const b = await seedMessageTrigger({ sortOrder: 2 });
    const c = await seedMessageTrigger({ sortOrder: 3 });

    const res = await reorder("bot_dm", [c, a, b]);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ location: "bot_dm", ids: [c, a, b] });
    expect(await matchingOrder()).toEqual([c, x, a, b]);
  });

  it("orders triggers that shared one sortOrder", async () => {
    const a = await seedMessageTrigger({ sortOrder: 0 });
    const b = await seedMessageTrigger({ sortOrder: 0 });
    const c = await seedMessageTrigger({ sortOrder: 0 });
    expect((await reorder("bot_dm", [c, a, b])).statusCode).toBe(200);
    expect(await matchingOrder()).toEqual([c, a, b]);
  });

  it("orders a guild location on its own", async () => {
    const dm = await seedMessageTrigger({ sortOrder: 0 });
    const g1 = await seedMessageTrigger({ sortOrder: 1, ...inGuild });
    const g2 = await seedMessageTrigger({ sortOrder: 2, ...inGuild });
    expect((await reorder(`guild:${GUILD}`, [g2, g1])).statusCode).toBe(200);
    expect(await matchingOrder()).toEqual([dm, g2, g1]);
  });

  it("keeps the System Behavior pinned first", async () => {
    const login = await seedSystemLogin();
    const a = await seedMessageTrigger({ sortOrder: 0 });
    const b = await seedMessageTrigger({ sortOrder: 1 });
    expect((await reorder("bot_dm", [b, a])).statusCode).toBe(200);
    const { messageTriggers } = await loadBehaviorCatalog();
    expect(messageTriggers.map((t) => t.id)).toEqual([login, b, a]);
  });

  it("leaves the System Behavior's row untouched and bumps no updatedAt", async () => {
    const login = await seedSystemLogin();
    const a = await seedMessageTrigger({ sortOrder: 4 });
    const b = await seedMessageTrigger({ sortOrder: 9 });
    const before = new Map((await loadBehaviorCatalog()).messageTriggers.map((t) => [t.id, t]));
    await new Promise((r) => setTimeout(r, 5)); // a write would get a later timestamp

    expect((await reorder("bot_dm", [b, a])).statusCode).toBe(200);

    const after = new Map((await loadBehaviorCatalog()).messageTriggers.map((t) => [t.id, t]));
    expect(after.get(login)!.sortOrder).toBe(-1000);
    for (const id of [login, a, b]) {
      expect(after.get(id)!.updatedAt.toISOString()).toBe(before.get(id)!.updatedAt.toISOString());
    }
  });

  it("refuses to move the System Behavior", async () => {
    const login = await seedSystemLogin();
    const a = await seedMessageTrigger({ sortOrder: 0 });
    const res = await reorder("bot_dm", [a, login]);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("system_immutable");
  });

  it("refuses a list that no longer matches the location", async () => {
    const a = await seedMessageTrigger({ sortOrder: 0 });
    await seedMessageTrigger({ sortOrder: 1 }); // added by someone else
    const res = await reorder("bot_dm", [a]);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({ code: "validation_failed", field: "ids" });
  });

  it("refuses a trigger from another location", async () => {
    const a = await seedMessageTrigger({ sortOrder: 0 });
    const x = await seedMessageTrigger({ sortOrder: 1, ...inGuild });
    const res = await reorder("bot_dm", [x, a]);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({ code: "validation_failed", field: "ids" });
  });

  it.each([
    ["an unknown location", { location: "app", ids: [1] }, "location"],
    ["a duplicated id", { location: "bot_dm", ids: [1, 1] }, "ids"],
    ["a non-integer id", { location: "bot_dm", ids: ["1"] }, "ids.0"],
  ])("refuses %s", async (_what, payload, field) => {
    const res = await server.inject({ method: "PUT", url: "/api/behaviors/reorder", payload });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatchObject({ code: "validation_failed", field });
  });

  it("records the new order in admin_audit_log", async () => {
    const a = await seedMessageTrigger({ sortOrder: 0 });
    const b = await seedMessageTrigger({ sortOrder: 1 });
    await reorder("bot_dm", [b, a]);
    const [entry] = await listAudit({ limit: 1 });
    expect(entry).toMatchObject({
      action: "behavior.reorder",
      target: "location:bot_dm",
      context: { ids: [b, a] },
    });
  });
});

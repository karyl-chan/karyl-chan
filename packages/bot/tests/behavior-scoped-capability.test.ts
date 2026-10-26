/**
 * ADR 0003 removed per-scope-tab delegation (`behavior:<scopeKey>.manage`);
 * the behavior module is gated by `behavior.manage` (or `admin`) alone.
 *
 * A stored scoped token is no longer a capability: it does not parse,
 * and a role holding only one is refused at the module entry (#93 — a
 * scoped token could rewrite a row's reach fields to widen it).
 */
import { vi, describe, it, expect, beforeAll } from "vitest";

vi.hoisted(() => {
  process.env.SQLITE_DB_PATH = ":memory:";
  process.env.ENCRYPTION_KEY = "a".repeat(64);
});

import Fastify, { type FastifyInstance } from "fastify";
import { sequelize } from "../src/db.js";
import { registerBehaviorRoutes } from "../src/modules/behavior/behavior-routes.js";
import { isAdminCapability } from "../src/modules/admin/admin-capabilities.js";

async function buildServer(caps: string[]): Promise<FastifyInstance> {
  const fastify = Fastify({ logger: false });
  fastify.addHook("onRequest", async (request) => {
    request.authUserId = "some-user";
    request.authCapabilities = new Set(caps) as never;
  });
  await registerBehaviorRoutes(fastify);
  await fastify.ready();
  return fastify;
}

beforeAll(async () => {
  await sequelize.sync({ force: true });
});

describe("behavior module gate", () => {
  it("a behavior:<scopeKey>.manage token is not a capability", () => {
    expect(isAdminCapability("behavior:global_all.manage")).toBe(false);
    expect(isAdminCapability("behavior:guild:G1.manage")).toBe(false);
    expect(isAdminCapability("behavior.manage")).toBe(true);
  });

  it("a role holding only a scoped token is refused", async () => {
    const server = await buildServer(["behavior:guild:G1.manage"]);
    const list = await server.inject({ method: "GET", url: "/api/behaviors" });
    expect(list.statusCode).toBe(403);
    const members = await server.inject({
      method: "PUT",
      url: "/api/behavior-groups/vip/members",
      payload: { userIds: ["123456789"] },
    });
    expect(members.statusCode).toBe(403);
    await server.close();
  });

  it("behavior.manage opens the module", async () => {
    const server = await buildServer(["behavior.manage"]);
    const list = await server.inject({ method: "GET", url: "/api/behaviors" });
    expect(list.statusCode).toBe(200);
    await server.close();
  });

  it("a user with no behavior capability at all gets 403", async () => {
    const server = await buildServer(["system.read"]);
    const res = await server.inject({ method: "GET", url: "/api/behaviors" });
    expect(res.statusCode).toBe(403);
    await server.close();
  });
});

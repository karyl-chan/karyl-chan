/**
 * #136 / #95 — every behavior route answers a refusal with one body shape,
 * `{ error: { code, message, field? } }`, and its request schema is
 * strict: unknown properties are refused (not silently dropped) and ids
 * are Discord snowflakes.
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
import { clearBehaviors, seedSystemLogin } from "./behavior-fixtures.js";

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

describe("behavior route errors", () => {
  it("a malformed id is validation_failed on the id field", async () => {
    const res = await server.inject({ method: "POST", url: "/api/behaviors/abc/test" });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      error: { code: "validation_failed", message: expect.any(String), field: "id" },
    });
  });

  it("an unknown behavior is not_found", async () => {
    const res = await server.inject({ method: "POST", url: "/api/behaviors/9999/test" });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toMatchObject({ code: "not_found" });
  });

  it("test-firing the system behavior is validation_failed (it has no webhook)", async () => {
    const id = await seedSystemLogin();
    const res = await server.inject({ method: "POST", url: `/api/behaviors/${id}/test` });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatchObject({ code: "validation_failed" });
  });

  it("an unknown body property is refused, not dropped", async () => {
    const res = await server.inject({
      method: "PUT",
      url: "/api/behavior-groups/vip/members",
      payload: { userIds: [], extra: true },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatchObject({ code: "validation_failed", field: "extra" });
  });

  it("a member id that is not a snowflake is refused on its field", async () => {
    const res = await server.inject({
      method: "PUT",
      url: "/api/behavior-groups/vip/members",
      payload: { userIds: ["123456789012345678", "12345"] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatchObject({
      code: "validation_failed",
      field: "userIds.1",
    });
  });

  it("a missing body is validation_failed", async () => {
    const res = await server.inject({
      method: "PUT",
      url: "/api/behavior-groups/vip/members",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatchObject({ code: "validation_failed" });
  });

  it("a body Fastify cannot parse still answers the uniform body", async () => {
    const res = await server.inject({
      method: "PUT",
      url: "/api/behavior-groups/vip/members",
      headers: { "content-type": "application/xml" },
      payload: "<userIds/>",
    });
    expect(res.statusCode).toBe(415);
    expect(res.json().error).toMatchObject({ code: "validation_failed" });
  });

  it("types are not coerced", async () => {
    const res = await server.inject({
      method: "PUT",
      url: "/api/behavior-groups/vip/members",
      payload: { userIds: [123456789012345678] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatchObject({ code: "validation_failed", field: "userIds.0" });
  });
});

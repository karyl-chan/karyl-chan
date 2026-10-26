/**
 * BH-6 — operational surface:
 *   - forward stats recorded per behavior (success/failure/consecutive)
 *   - POST /api/behaviors/:id/test fires the webhook and returns the
 *     outcome without touching stats
 *
 * (The matcher / dispatcher recording an outcome per forward and the list
 * route attaching stats are covered with those seams.)
 */
import { vi, describe, it, expect, beforeAll, beforeEach, type Mock } from "vitest";

vi.hoisted(() => {
  process.env.SQLITE_DB_PATH = ":memory:";
  process.env.ENCRYPTION_KEY = "a".repeat(64);
});

vi.mock("../src/modules/bot-events/bot-event-log.js", () => ({
  botEventLog: { record: vi.fn() },
}));

import Fastify, { type FastifyInstance } from "fastify";
import { sequelize } from "../src/db.js";
import {
  recordForwardOutcome,
  findStatsBulk,
} from "../src/modules/behavior/models/behavior-stats.model.js";
import { registerBehaviorRoutes } from "../src/modules/behavior/behavior-routes.js";
import { clearBehaviors, seedMessageTrigger } from "./behavior-fixtures.js";

async function buildServer(forwarder?: unknown): Promise<FastifyInstance> {
  const fastify = Fastify({ logger: false });
  fastify.addHook("onRequest", async (request) => {
    request.authUserId = "admin-test";
    request.authCapabilities = new Set(["admin"]);
  });
  await registerBehaviorRoutes(fastify, { forwarder: forwarder as never });
  await fastify.ready();
  return fastify;
}

beforeAll(async () => {
  await sequelize.sync({ force: true });
});

beforeEach(async () => {
  vi.clearAllMocks();
  await clearBehaviors();
});

describe("BH-6.1 forward stats", () => {
  it("records success/failure and resets the consecutive counter", async () => {
    const id = await seedMessageTrigger();
    await recordForwardOutcome(id, false, "boom");
    await recordForwardOutcome(id, false, "boom2");
    let st = (await findStatsBulk([id])).get(id)!;
    expect(st.failureCount).toBe(2);
    expect(st.consecutiveFailures).toBe(2);
    expect(st.lastError).toBe("boom2");

    await recordForwardOutcome(id, true);
    st = (await findStatsBulk([id])).get(id)!;
    expect(st.successCount).toBe(1);
    expect(st.consecutiveFailures).toBe(0);
    expect(st.lastFiredAt).not.toBeNull();
  });
});

describe("BH-6.2 test-fire", () => {
  it("forwards a test payload and returns the outcome without stats", async () => {
    const id = await seedMessageTrigger();
    const forward: Mock = vi.fn(async () => ({
      ok: true,
      reply: { content: "pong" },
      notes: [],
    }));
    const server = await buildServer({ forward });
    const res = await server.inject({ method: "POST", url: `/api/behaviors/${id}/test` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, relayContent: "pong" });
    const payload = (forward.mock.calls[0] as unknown[])[1] as {
      _meta: { test: boolean };
    };
    expect(payload._meta.test).toBe(true);
    expect((await findStatsBulk([id])).get(id)).toBeUndefined();
    await server.close();
  });
});

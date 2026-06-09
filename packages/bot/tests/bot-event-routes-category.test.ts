/**
 * GET /api/admin/bot-events ?category= filter. Regression: the route's
 * category allowlist had drifted from BotEventCategory — "plugin" was a valid,
 * persisted category but absent from the allowlist, so `?category=plugin`
 * silently dropped the filter and returned EVERY category.
 */
import { vi, describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";

vi.hoisted(() => {
  process.env.SQLITE_DB_PATH = ":memory:";
  process.env.BOT_EVENTS_SQLITE_DB_PATH = ":memory:";
});

import Fastify, { type FastifyInstance } from "fastify";
import { botEventsSequelize } from "../src/modules/bot-events/bot-events-db.js";
import { BotEvent } from "../src/modules/bot-events/models/bot-event.model.js";
import { registerBotEventRoutes } from "../src/modules/bot-events/bot-event-routes.js";

async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.addHook("onRequest", (req, _reply, done) => {
    (req as unknown as { authUserId: string }).authUserId = "admin-user";
    (req as unknown as { authCapabilities: Set<string> }).authCapabilities =
      new Set(["admin"]);
    done();
  });
  await registerBotEventRoutes(app);
  await app.ready();
  return app;
}

beforeAll(async () => {
  await botEventsSequelize.sync({ force: true });
});

beforeEach(async () => {
  await BotEvent.destroy({ where: {} });
  await BotEvent.create({ level: "info", category: "plugin", message: "p1" });
  await BotEvent.create({ level: "info", category: "bot", message: "b1" });
});

afterAll(async () => {
  await botEventsSequelize.close();
});

describe("GET /api/admin/bot-events category filter", () => {
  it("filters to category=plugin (was unfilterable before)", async () => {
    const app = await buildServer();
    const res = await app.inject({
      method: "GET",
      url: "/api/admin/bot-events?category=plugin",
    });
    expect(res.statusCode).toBe(200);
    const { events } = res.json() as { events: Array<{ category: string }> };
    expect(events).toHaveLength(1);
    expect(events[0].category).toBe("plugin");
    await app.close();
  });

  it("still filters a previously-allowed category=bot", async () => {
    const app = await buildServer();
    const res = await app.inject({
      method: "GET",
      url: "/api/admin/bot-events?category=bot",
    });
    const { events } = res.json() as { events: Array<{ category: string }> };
    expect(events).toHaveLength(1);
    expect(events[0].category).toBe("bot");
    await app.close();
  });

  it("returns all categories when no filter is given", async () => {
    const app = await buildServer();
    const res = await app.inject({
      method: "GET",
      url: "/api/admin/bot-events",
    });
    const { events } = res.json() as { events: unknown[] };
    expect(events).toHaveLength(2);
    await app.close();
  });
});

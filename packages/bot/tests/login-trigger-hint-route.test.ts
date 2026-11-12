/**
 * #146 — GET /api/auth/login-trigger: the admin login page, before anyone
 * is signed in, learns how to ask the bot for a login link — the System
 * Behavior's current trigger, and nothing else. Public, read-only and
 * rate-limited per client like the other /api/auth/* endpoints.
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
import { invalidateBehaviorCatalog } from "../src/modules/behavior/behavior-catalog.js";
import { registerLoginTriggerHintRoute } from "../src/modules/behavior/login-trigger-hint-route.js";
import { Service } from "../src/modules/behavior/models/service.model.js";
import { BehaviorCommand } from "../src/modules/behavior/models/behavior-command.model.js";
import { BehaviorDefinition } from "../src/modules/behavior/models/behavior-definition.model.js";
import { BehaviorWebhookAction } from "../src/modules/behavior/models/behavior-webhook-action.model.js";
import { BehaviorPluginAction } from "../src/modules/behavior/models/behavior-plugin-action.model.js";
import { BehaviorDmAllowlist } from "../src/modules/behavior/models/behavior-dm-allowlist.model.js";
import { BehaviorGroupMember } from "../src/modules/behavior/models/behavior-group-member.model.js";
import { BehaviorDmLog } from "../src/modules/behavior/models/behavior-dm-log.model.js";
import { RateLimiter } from "../src/utils/rate-limiter.js";
// Static on purpose: a dynamic import in the test body bills the large
// web-server graph to the 5s test timeout (#181).
import { createWebServer } from "../src/modules/web-core/server.js";
import { clearBehaviors, seedCommand, seedLeaf, seedSystemLogin } from "./behavior-fixtures.js";

let server: FastifyInstance;

beforeAll(async () => {
  // Only the behavior tables, not sequelize.sync(): the web-core import
  // above registers every model (32 tables, ~185 serial SQLite round
  // trips), and under full-suite CPU load each round trip waits on the
  // scheduler, which pushed this hook past its 10s timeout (#181).
  for (const model of [
    Service,
    BehaviorCommand,
    BehaviorDefinition,
    BehaviorWebhookAction,
    BehaviorPluginAction,
    BehaviorDmAllowlist,
    BehaviorGroupMember,
    BehaviorDmLog,
  ]) {
    await model.sync({ force: true });
  }
  server = Fastify({ logger: false });
  registerLoginTriggerHintRoute(server, { limiter: new RateLimiter({ windowMs: 60_000, max: 3 }) });
  await server.ready();
});

beforeEach(async () => {
  await clearBehaviors();
  invalidateBehaviorCatalog();
});

function hint(ip = "198.51.100.1") {
  return server.inject({ method: "GET", url: "/api/auth/login-trigger", remoteAddress: ip });
}

describe("GET /api/auth/login-trigger", () => {
  it("names the DM message the login answers", async () => {
    await seedSystemLogin();
    const res = await hint("198.51.100.10");
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.json()).toEqual({ trigger: { kind: "message", match: "startswith", text: "!login" } });
  });

  it("names the command when the login is one", async () => {
    const commandId = await seedCommand({ name: "signin", contexts: "BotDM", isSystem: true });
    await seedLeaf(commandId, { systemKey: "admin-login", actionSource: "builtin" }, null);
    const res = await hint("198.51.100.11");
    expect(res.json()).toEqual({ trigger: { kind: "command", text: "/signin" } });
  });

  it("answers null when there is no login trigger", async () => {
    const res = await hint("198.51.100.12");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ trigger: null });
  });

  it("is rate-limited per client", async () => {
    await seedSystemLogin();
    for (let i = 0; i < 3; i++) expect((await hint("198.51.100.13")).statusCode).toBe(200);
    expect((await hint("198.51.100.13")).statusCode).toBe(429);
    // another client is not affected
    expect((await hint("198.51.100.14")).statusCode).toBe(200);
  });
});

describe("on the web server", () => {
  it("is served without a session, while the admin API still asks for one", async () => {
    const web = await createWebServer({ ownerIds: ["111111111111111111"], staticRoot: undefined });
    try {
      await seedSystemLogin();
      const res = await web.inject({ method: "GET", url: "/api/auth/login-trigger" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ trigger: { kind: "message", match: "startswith", text: "!login" } });
      expect((await web.inject({ method: "GET", url: "/api/behaviors" })).statusCode).toBe(401);
    } finally {
      await web.close();
    }
  });
});

/**
 * #100 — the behavior routes refuse a webhook target the policy would
 * refuse, on save (400) and on test-fire, with the readable reason and
 * the machine code. Literal-IP URLs only, so no DNS is involved.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.SQLITE_DB_PATH = ":memory:";
  process.env.ENCRYPTION_KEY = "a".repeat(64);
  delete process.env.WEBHOOK_ALLOW_PRIVATE;
});

import Fastify, { type FastifyInstance } from "fastify";
import { sequelize } from "../src/db.js";
import { Behavior } from "../src/modules/behavior/models/behavior.model.js";
import { registerBehaviorRoutes } from "../src/modules/behavior/behavior-routes.js";
import { encryptSecret } from "../src/utils/crypto.js";

let server: FastifyInstance;

beforeAll(async () => {
  await sequelize.sync({ force: true });
  server = Fastify({ logger: false });
  server.addHook("onRequest", async (request) => {
    request.authUserId = "test";
    request.authCapabilities = new Set(["admin"]);
  });
  await registerBehaviorRoutes(server, {
    reconciler: { reconcileAll: async () => undefined } as never,
  });
  await server.ready();
});

afterAll(async () => {
  await server.close();
});

beforeEach(async () => {
  await Behavior.destroy({ where: {} });
});

function createPayload(webhookUrl: string) {
  return {
    title: "lan hook",
    triggerType: "slash_command",
    slashCommandName: "lan",
    webhookUrl,
  };
}

async function seedRow(webhookUrl: string): Promise<void> {
  await Behavior.create({
    id: 7,
    title: "seeded",
    enabled: true,
    sortOrder: 0,
    stopOnMatch: false,
    ignoreBots: true,
    forwardType: "one_time",
    source: "custom",
    triggerType: "message_pattern",
    messagePatternKind: "startswith",
    messagePatternValue: "!x",
    scope: "global",
    integrationTypes: "guild_install,user_install",
    contexts: "BotDM",
    audienceKind: "all",
    webhookUrl: encryptSecret(webhookUrl),
    scopeTabId: 1,
  } as Record<string, unknown>);
}

describe("behavior webhook target refusals", () => {
  it("POST refuses a non-allowlisted LAN target with a readable reason", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/api/behaviors",
      payload: createPayload("http://192.168.2.40/hook"),
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: string; code: string };
    expect(body.code).toBe("private_not_allowlisted");
    expect(body.error).toContain("192.168.2.40");
    expect(body.error).toContain("WEBHOOK_PRIVATE_ALLOWLIST");
  });

  it("POST refuses plain http to a public address", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/api/behaviors",
      payload: createPayload("http://203.0.113.10/hook"),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: "https_required" });
  });

  it("PATCH refuses a loopback target", async () => {
    await seedRow("https://203.0.113.10/hook");
    const res = await server.inject({
      method: "PATCH",
      url: "/api/behaviors/7",
      payload: { webhookUrl: "http://127.0.0.1:8080/hook" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: "blocked_loopback" });
  });

  it("test-fire reports the refusal and its code instead of sending", async () => {
    // A row saved before the policy tightened (or with the env changed
    // since) is re-checked at send time.
    await seedRow("http://192.168.2.40/hook");
    const res = await server.inject({
      method: "POST",
      url: "/api/behaviors/7/test",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; error: string; errorCode: string };
    expect(body.ok).toBe(false);
    expect(body.errorCode).toBe("private_not_allowlisted");
    expect(body.error).toContain("WEBHOOK_PRIVATE_ALLOWLIST");
  });
});

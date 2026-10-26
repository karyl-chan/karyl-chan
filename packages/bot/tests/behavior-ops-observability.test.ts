/**
 * BH-6 — operational surface:
 *   - forward stats recorded per behavior (success/failure/consecutive)
 *   - POST /api/behaviors/:id/test fires the webhook and returns the
 *     outcome without touching stats
 */
import { vi, describe, it, expect, beforeAll, beforeEach, type Mock } from "vitest";

vi.hoisted(() => {
  process.env.SQLITE_DB_PATH = ":memory:";
  process.env.ENCRYPTION_KEY = "a".repeat(64);
});

vi.mock("../src/modules/bot-events/bot-event-log.js", () => ({
  botEventLog: { record: vi.fn() },
}));
vi.mock("../src/utils/host-policy.js", async (importOriginal) => {
  const mod = (await importOriginal()) as Record<string, unknown>;
  return {
    ...mod,
    resolveWebhookTarget: vi.fn(async (u: string | URL) => ({
      url: new URL(u),
      addresses: [{ address: "203.0.113.10", family: 4 }],
    })),
  };
});

import Fastify, { type FastifyInstance } from "fastify";
import { ChannelType } from "discord.js";
import { sequelize } from "../src/db.js";
import { Behavior } from "../src/modules/behavior/models/behavior.model.js";
import {
  BehaviorStat,
  recordForwardOutcome,
  findStatsBulk,
} from "../src/modules/behavior/models/behavior-stats.model.js";
import { registerBehaviorRoutes } from "../src/modules/behavior/behavior-routes.js";
import { MessagePatternMatcher } from "../src/modules/command-system/message-pattern-matcher.service.js";
import type { WebhookForwarder } from "../src/modules/command-system/webhook-forwarder.service.js";
import { encryptSecret } from "../src/utils/crypto.js";

async function buildServer(forwarder?: unknown): Promise<FastifyInstance> {
  const fastify = Fastify({ logger: false });
  fastify.addHook("onRequest", async (request) => {
    request.authUserId = "admin-test";
    request.authCapabilities = new Set(["admin"]);
  });
  await registerBehaviorRoutes(fastify, {
    reconciler: { reconcileAll: async () => undefined } as never,
    forwarder: forwarder as never,
  });
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
  messagePatternValue: "!s",
  scope: "global",
  integrationTypes: "guild_install,user_install",
  contexts: "BotDM",
  audienceKind: "all",
  webhookUrl: encryptSecret("https://example.test/hook"),
  scopeTabId: 1,
} as const;

beforeAll(async () => {
  await sequelize.sync({ force: true });
});

beforeEach(async () => {
  vi.clearAllMocks();
  await Behavior.destroy({ where: {} });
  await BehaviorStat.destroy({ where: {} });
});

describe("BH-6.1 forward stats", () => {
  it("records success/failure and resets the consecutive counter", async () => {
    await Behavior.create({ id: 1, title: "s", ...BASE } as Record<string, unknown>);
    await recordForwardOutcome(1, false, "boom");
    await recordForwardOutcome(1, false, "boom2");
    let st = (await findStatsBulk([1])).get(1)!;
    expect(st.failureCount).toBe(2);
    expect(st.consecutiveFailures).toBe(2);
    expect(st.lastError).toBe("boom2");

    await recordForwardOutcome(1, true);
    st = (await findStatsBulk([1])).get(1)!;
    expect(st.successCount).toBe(1);
    expect(st.consecutiveFailures).toBe(0);
    expect(st.lastFiredAt).not.toBeNull();
  });

  it("the matcher records an outcome per forward", async () => {
    await Behavior.create({ id: 2, title: "m", ...BASE } as Record<string, unknown>);
    const forwarder = {
      forward: vi.fn(async () => ({ ok: true, relayContent: "" })),
    };
    const matcher = new MessagePatternMatcher(
      forwarder as unknown as WebhookForwarder,
    );
    await matcher.onMessage({
      id: "M",
      content: "!s hi",
      guildId: null,
      author: {
        id: "U1",
        bot: false,
        username: "u",
        displayAvatarURL: () => "https://cdn.example/a.png",
      },
      client: { user: { id: "BOT" } },
      channel: { id: "DM-U1", type: ChannelType.DM, send: vi.fn(async () => {}) },
    } as never);
    const st = (await findStatsBulk([2])).get(2);
    expect(st?.successCount).toBe(1);
  });

  it("GET /api/behaviors attaches stats", async () => {
    await Behavior.create({ id: 3, title: "ls", ...BASE } as Record<string, unknown>);
    await recordForwardOutcome(3, true);
    const server = await buildServer();
    const res = await server.inject({ method: "GET", url: "/api/behaviors" });
    const row = (res.json().behaviors as Array<{ id: number; stats: unknown }>)[0];
    expect((row.stats as { successCount: number }).successCount).toBe(1);
    await server.close();
  });
});

describe("BH-6.2 test-fire", () => {
  it("forwards a test payload and returns the outcome without stats", async () => {
    await Behavior.create({ id: 4, title: "t", ...BASE } as Record<string, unknown>);
    const forward: Mock = vi.fn(async () => ({
      ok: true,
      relayContent: "pong",
      relayEmbeds: [],
    }));
    const server = await buildServer({ forward });
    const res = await server.inject({ method: "POST", url: "/api/behaviors/4/test" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, relayContent: "pong" });
    const payload = (forward.mock.calls[0] as unknown[])[1] as {
      _meta: { test: boolean };
    };
    expect(payload._meta.test).toBe(true);
    expect((await findStatsBulk([4])).get(4)).toBeUndefined();
    await server.close();
  });
});

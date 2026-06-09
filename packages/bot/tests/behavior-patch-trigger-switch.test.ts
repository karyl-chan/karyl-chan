/**
 * Switching a CUSTOM behavior's triggerType via PATCH must clear the previous
 * trigger type's columns. The row is saved with an instance update, so the
 * whole row enters the triggerTypeShape validate context — leaving the old
 * side populated makes the validator throw and 500s the edit. These tests
 * lock the reconcile step in the custom PATCH branch.
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

async function buildServer(): Promise<FastifyInstance> {
  const fastify = Fastify({ logger: false });
  fastify.addHook("onRequest", async (request) => {
    request.authUserId = "test";
    request.authCapabilities = new Set(["admin"]);
  });
  await registerBehaviorRoutes(fastify, {
    reconciler: {
      reconcileAll: async () => ({ created: 0, patched: 0, deleted: 0, errors: [] }),
      reconcileForGuild: async () => undefined,
      reconcileForBehavior: async () => ({
        ok: true,
        source: "behavior" as const,
        sourceId: 0,
        action: "noop" as const,
      }),
    } as never,
  });
  await fastify.ready();
  return fastify;
}

const BASE = {
  enabled: true,
  sortOrder: 0,
  stopOnMatch: true,
  forwardType: "one_time",
  source: "custom",
  webhookUrl: encryptSecret("https://example.test/hook"),
  scope: "global",
  integrationTypes: "guild_install,user_install",
  contexts: "BotDM",
  audienceKind: "all",
  scopeTabId: 1,
} as const;

async function seedSlash(id: number): Promise<void> {
  await Behavior.create({
    id,
    title: "custom-slash",
    triggerType: "slash_command",
    slashCommandName: "deploy",
    slashCommandDescription: "d",
    ...BASE,
  } as Record<string, unknown>);
}

async function seedMsgPattern(id: number): Promise<void> {
  await Behavior.create({
    id,
    title: "custom-msg",
    triggerType: "message_pattern",
    messagePatternKind: "startswith",
    messagePatternValue: "!hello",
    ...BASE,
  } as Record<string, unknown>);
}

beforeAll(async () => {
  await sequelize.sync({ force: true });
});

beforeEach(async () => {
  await Behavior.destroy({ where: {} });
});

describe("custom behavior PATCH triggerType switch", () => {
  it("slash_command → message_pattern clears slashCommandName and succeeds", async () => {
    await seedSlash(1);
    const server = await buildServer();
    const res = await server.inject({
      method: "PATCH",
      url: "/api/behaviors/1",
      payload: {
        triggerType: "message_pattern",
        messagePatternKind: "startswith",
        messagePatternValue: "!deploy",
      },
    });
    expect(res.statusCode).toBe(200);
    const row = await Behavior.findByPk(1);
    expect(row?.getDataValue("triggerType")).toBe("message_pattern");
    expect(row?.getDataValue("messagePatternValue")).toBe("!deploy");
    // The previous trigger's column must be cleared, not left stale.
    expect(row?.getDataValue("slashCommandName")).toBeNull();
    await server.close();
  });

  it("message_pattern → slash_command clears messagePattern columns", async () => {
    await seedMsgPattern(1);
    const server = await buildServer();
    const res = await server.inject({
      method: "PATCH",
      url: "/api/behaviors/1",
      payload: { triggerType: "slash_command", slashCommandName: "ship" },
    });
    expect(res.statusCode).toBe(200);
    const row = await Behavior.findByPk(1);
    expect(row?.getDataValue("triggerType")).toBe("slash_command");
    expect(row?.getDataValue("slashCommandName")).toBe("ship");
    expect(row?.getDataValue("messagePatternKind")).toBeNull();
    expect(row?.getDataValue("messagePatternValue")).toBeNull();
    await server.close();
  });

  it("switch to slash_command without a name → 400 (not 500)", async () => {
    await seedMsgPattern(1);
    const server = await buildServer();
    const res = await server.inject({
      method: "PATCH",
      url: "/api/behaviors/1",
      payload: { triggerType: "slash_command" },
    });
    expect(res.statusCode).toBe(400);
    // unchanged
    const row = await Behavior.findByPk(1);
    expect(row?.getDataValue("triggerType")).toBe("message_pattern");
    await server.close();
  });
});

describe("custom behavior PATCH trigger sub-fields without triggerType", () => {
  it("rejects an out-of-enum messagePatternKind → 400 (not a silently dead behavior)", async () => {
    await seedMsgPattern(1);
    const server = await buildServer();
    const res = await server.inject({
      method: "PATCH",
      url: "/api/behaviors/1",
      payload: { messagePatternKind: "contains" },
    });
    expect(res.statusCode).toBe(400);
    // The invalid kind must NOT have been written.
    const row = await Behavior.findByPk(1);
    expect(row?.getDataValue("messagePatternKind")).toBe("startswith");
    await server.close();
  });

  it("rejects slashCommandName on a message_pattern behavior → 400 (not 500)", async () => {
    await seedMsgPattern(1);
    const server = await buildServer();
    const res = await server.inject({
      method: "PATCH",
      url: "/api/behaviors/1",
      payload: { slashCommandName: "mycommand" },
    });
    expect(res.statusCode).toBe(400);
    const row = await Behavior.findByPk(1);
    expect(row?.getDataValue("triggerType")).toBe("message_pattern");
    expect(row?.getDataValue("slashCommandName")).toBeNull();
    await server.close();
  });

  it("rejects slashCommandDescription on a message_pattern behavior → 400", async () => {
    await seedMsgPattern(1);
    const server = await buildServer();
    const res = await server.inject({
      method: "PATCH",
      url: "/api/behaviors/1",
      payload: { slashCommandDescription: "desc" },
    });
    expect(res.statusCode).toBe(400);
    await server.close();
  });

  it("rejects messagePatternValue on a slash_command behavior → 400 (not 500)", async () => {
    await seedSlash(1);
    const server = await buildServer();
    const res = await server.inject({
      method: "PATCH",
      url: "/api/behaviors/1",
      payload: { messagePatternValue: "!hi" },
    });
    expect(res.statusCode).toBe(400);
    await server.close();
  });

  it("still allows a valid same-type sub-field edit (messagePatternKind)", async () => {
    await seedMsgPattern(1);
    const server = await buildServer();
    const res = await server.inject({
      method: "PATCH",
      url: "/api/behaviors/1",
      payload: { messagePatternKind: "endswith" },
    });
    expect(res.statusCode).toBe(200);
    const row = await Behavior.findByPk(1);
    expect(row?.getDataValue("messagePatternKind")).toBe("endswith");
    await server.close();
  });

  it("allows clearing the opposite side with null (no-op) → 200", async () => {
    await seedMsgPattern(1);
    const server = await buildServer();
    const res = await server.inject({
      method: "PATCH",
      url: "/api/behaviors/1",
      payload: { slashCommandName: null },
    });
    expect(res.statusCode).toBe(200);
    await server.close();
  });
});

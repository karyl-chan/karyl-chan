/**
 * BH-2.2C — admin-defined slash command options.
 *
 * parseSlashCommandOptions enforces Discord's hard rules (name format,
 * description length, required-before-optional ordering, unique names,
 * count cap, type whitelist). The routes store the canonical JSON on
 * slash behaviors only.
 */
import { vi, describe, it, expect, beforeAll, beforeEach } from "vitest";

vi.hoisted(() => {
  process.env.SQLITE_DB_PATH = ":memory:";
  process.env.ENCRYPTION_KEY = "a".repeat(64);
});

// POST validates webhookUrl against the host policy with a live DNS
// lookup — stub it so the offline test suite can create behaviors.
vi.mock("../src/utils/host-policy.js", async (importOriginal) => {
  const mod = (await importOriginal()) as Record<string, unknown>;
  return { ...mod, assertExternalTarget: vi.fn(async () => {}) };
});

import Fastify, { type FastifyInstance } from "fastify";
import { sequelize } from "../src/db.js";
import { Behavior } from "../src/modules/behavior/models/behavior.model.js";
import { registerBehaviorRoutes } from "../src/modules/behavior/behavior-routes.js";
import { parseSlashCommandOptions } from "../src/modules/behavior/behavior-helpers.js";
import { encryptSecret } from "../src/utils/crypto.js";

describe("parseSlashCommandOptions", () => {
  it("accepts a valid flat option list", () => {
    const r = parseSlashCommandOptions([
      { type: "string", name: "query", description: "What to ask", required: true },
      { type: "integer", name: "count", description: "How many" },
    ]);
    expect(r).toEqual({
      ok: true,
      options: [
        { type: "string", name: "query", description: "What to ask", required: true },
        { type: "integer", name: "count", description: "How many", required: false },
      ],
    });
  });

  it("rejects unknown types, bad names, dupes, and required-after-optional", () => {
    expect(
      parseSlashCommandOptions([{ type: "sub_command", name: "x", description: "d" }]).ok,
    ).toBe(false);
    expect(
      parseSlashCommandOptions([{ type: "string", name: "BadName", description: "d" }]).ok,
    ).toBe(false);
    expect(
      parseSlashCommandOptions([
        { type: "string", name: "a", description: "d" },
        { type: "string", name: "a", description: "d" },
      ]).ok,
    ).toBe(false);
    expect(
      parseSlashCommandOptions([
        { type: "string", name: "a", description: "d" },
        { type: "string", name: "b", description: "d", required: true },
      ]).ok,
    ).toBe(false);
    expect(parseSlashCommandOptions("nope").ok).toBe(false);
  });
});

describe("routes store slash options", () => {
  async function buildServer(): Promise<FastifyInstance> {
    const fastify = Fastify({ logger: false });
    fastify.addHook("onRequest", async (request) => {
      request.authUserId = "test";
      request.authCapabilities = new Set(["admin"]);
    });
    await registerBehaviorRoutes(fastify, {
      reconciler: { reconcileAll: async () => undefined } as never,
    });
    await fastify.ready();
    return fastify;
  }

  beforeAll(async () => {
    await sequelize.sync({ force: true });
  });

  beforeEach(async () => {
    await Behavior.destroy({ where: {} });
  });

  it("POST stores canonical options JSON for a slash behavior", async () => {
    const server = await buildServer();
    const res = await server.inject({
      method: "POST",
      url: "/api/behaviors",
      payload: {
        title: "with options",
        triggerType: "slash_command",
        slashCommandName: "ask",
        webhookUrl: "https://example.test/hook",
        slashCommandOptions: [
          { type: "string", name: "query", description: "What", required: true },
        ],
      },
    });
    expect(res.statusCode).toBe(201);
    const id = res.json().behavior.id as number;
    const row = await Behavior.findByPk(id);
    expect(
      JSON.parse(row?.getDataValue("slashCommandOptions") as string),
    ).toEqual([
      { type: "string", name: "query", description: "What", required: true },
    ]);
    await server.close();
  });

  it("PATCH rejects options on a pattern behavior and bad options on slash", async () => {
    await Behavior.create({
      id: 5,
      title: "pat",
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
      webhookUrl: encryptSecret("https://example.test/hook"),
      scopeTabId: 1,
    } as Record<string, unknown>);
    const server = await buildServer();

    let res = await server.inject({
      method: "PATCH",
      url: "/api/behaviors/5",
      payload: {
        slashCommandOptions: [{ type: "string", name: "q", description: "d" }],
      },
    });
    expect(res.statusCode).toBe(400);

    // switching to slash in the same body allows options
    res = await server.inject({
      method: "PATCH",
      url: "/api/behaviors/5",
      payload: {
        triggerType: "slash_command",
        slashCommandName: "switched",
        slashCommandOptions: [{ type: "string", name: "q", description: "d" }],
      },
    });
    expect(res.statusCode).toBe(200);

    res = await server.inject({
      method: "PATCH",
      url: "/api/behaviors/5",
      payload: { slashCommandOptions: [{ type: "nope", name: "q", description: "d" }] },
    });
    expect(res.statusCode).toBe(400);
    await server.close();
  });
});

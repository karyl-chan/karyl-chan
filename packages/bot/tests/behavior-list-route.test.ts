/**
 * Admin behaviors API on the trigger/action model (S3, read-only).
 *
 *   GET /api/behaviors → { system, commands, messageTriggers }; every item
 *   carries its derived Behavior Section; webhook secrets are reported only
 *   as `secretSet`. Test-fire works on a behavior's webhook action.
 */
import { vi, describe, it, expect, beforeAll } from "vitest";

vi.hoisted(() => {
  process.env.SQLITE_DB_PATH = ":memory:";
  process.env.ENCRYPTION_KEY = "a".repeat(64);
});

vi.mock("../src/modules/bot-events/bot-event-log.js", () => ({
  botEventLog: { record: vi.fn() },
}));

import Fastify, { type FastifyInstance } from "fastify";
import { sequelize } from "../src/db.js";
import { BehaviorStat } from "../src/modules/behavior/models/behavior-stats.model.js";
import { registerBehaviorRoutes } from "../src/modules/behavior/behavior-routes.js";
import { encryptSecret } from "../src/utils/crypto.js";
import {
  TEST_WEBHOOK_URL,
  seedCommand,
  seedLeaf,
  seedMessageTrigger,
  seedSystemLogin,
} from "./behavior-fixtures.js";

const SECRET = "very-secret-value";
const forward = vi.fn(async () => ({ ok: true, reply: { content: "pong" }, notes: [] }));

let server: FastifyInstance;
const ids: Record<string, number> = {};

beforeAll(async () => {
  await sequelize.sync({ force: true });
  ids.login = await seedSystemLogin();
  ids.dm = await seedMessageTrigger(
    { title: "dm hello", sortOrder: 1, audienceKind: "user", audienceUserId: "U1" },
    { secret: encryptSecret(SECRET), authMode: "hmac" },
  );
  ids.channel = await seedMessageTrigger({
    title: "channel q",
    sortOrder: 2,
    surface: "guild",
    guildId: "G1",
    channelId: "C1",
    patternKind: "endswith",
    patternValue: "?",
  });
  ids.nas = await seedCommand({
    name: "nas",
    description: "NAS tools",
    registration: "guild",
    guildId: "G1",
  });
  ids.nasWake = await seedLeaf(ids.nas, {
    title: "wake",
    subcommand: "wake",
    leafDescription: "Wake the NAS",
    options: JSON.stringify([
      { type: "string", name: "host", description: "host", required: true },
    ]),
  });
  ids.nasStatus = await seedLeaf(ids.nas, { title: "status", subcommand: "status" });
  ids.app = await seedCommand({
    name: "app",
    integrationTypes: "guild_install,user_install",
    contexts: "BotDM,Guild",
  });
  ids.appLeaf = await seedLeaf(ids.app, { title: "app" });
  await BehaviorStat.create({ behaviorId: ids.dm, successCount: 3 });

  server = Fastify({ logger: false });
  server.addHook("onRequest", async (request) => {
    request.authUserId = "admin";
    request.authCapabilities = new Set(["behavior.manage"]) as never;
  });
  await registerBehaviorRoutes(server, { forwarder: { forward } as never });
  await server.ready();
});

describe("GET /api/behaviors", () => {
  it("pins the system behavior apart, in its derived section", async () => {
    const res = await server.inject({ method: "GET", url: "/api/behaviors" });
    expect(res.statusCode).toBe(200);
    const { system } = res.json();
    expect(system).toMatchObject({
      kind: "message",
      id: ids.login,
      systemKey: "admin-login",
      actionSource: "builtin",
      surface: "bot_dm",
      patternKind: "startswith",
      patternValue: "!login",
      section: "bot_dm",
      webhook: null,
    });
  });

  it("lists message triggers with their sections, never a secret", async () => {
    const res = await server.inject({ method: "GET", url: "/api/behaviors" });
    const body = res.json();
    const triggers = body.messageTriggers as Array<Record<string, unknown>>;
    expect(triggers.map((t) => [t.id, t.section])).toEqual([
      [ids.dm, "bot_dm"],
      [ids.channel, "channel:G1:C1"],
    ]);
    expect(triggers[0]).toMatchObject({
      audienceKind: "user",
      audienceUserId: "U1",
      webhook: { url: TEST_WEBHOOK_URL, authMode: "hmac", secretSet: true },
      stats: { successCount: 3 },
    });
    expect(triggers[1]).toMatchObject({
      webhook: { url: TEST_WEBHOOK_URL, authMode: null, secretSet: false },
      stats: null,
    });
    expect(res.body).not.toContain(SECRET);
  });

  it("lists commands with their leaves and sections", async () => {
    const res = await server.inject({ method: "GET", url: "/api/behaviors" });
    const commands = res.json().commands as Array<Record<string, unknown>>;
    expect(commands.map((c) => [c.name, c.section])).toEqual([
      ["nas", "guild:G1"],
      ["app", "app"],
    ]);
    expect(commands[0]).toMatchObject({
      kind: "command",
      registration: "guild",
      guildId: "G1",
      contexts: ["Guild"],
      integrationTypes: ["guild_install"],
      defaultMemberPermissions: null,
      isSystem: false,
    });
    const leaves = commands[0].leaves as Array<Record<string, unknown>>;
    expect(leaves.map((l) => l.subcommand).sort()).toEqual(["status", "wake"]);
    expect(leaves.find((l) => l.subcommand === "wake")).toMatchObject({
      id: ids.nasWake,
      leafDescription: "Wake the NAS",
      options: [{ type: "string", name: "host", description: "host", required: true }],
      actionSource: "webhook",
    });
  });
});

describe("POST /api/behaviors/:id/test", () => {
  it("fires the behavior's webhook action", async () => {
    forward.mockClear();
    const res = await server.inject({
      method: "POST",
      url: `/api/behaviors/${ids.appLeaf}/test`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, relayContent: "pong" });
    const calls = forward.mock.calls as unknown as Array<
      [unknown, { _meta: Record<string, unknown> }, { test?: boolean }]
    >;
    expect(calls[0][0]).toMatchObject({ behaviorId: ids.appLeaf });
    expect(calls[0][1]._meta).toMatchObject({ test: true, behavior_id: ids.appLeaf });
    // #101: signed as a test, never as the admin who pressed the button
    expect(calls[0][2]).toEqual({ test: true });
    expect(calls[0][1]._meta.user).toEqual({
      id: "0",
      username: "karyl-test",
      global_name: null,
      discriminator: "0",
      avatar: null,
    });
    expect(JSON.stringify(calls[0][1])).not.toContain('"admin"');
  });

  it("a message trigger's test carries the message keys", async () => {
    forward.mockClear();
    await server.inject({ method: "POST", url: `/api/behaviors/${ids.dm}/test` });
    const calls = forward.mock.calls as unknown as Array<[unknown, { _meta: Record<string, unknown> }]>;
    expect(calls[0][1]._meta.captures).toEqual([]);
  });

  it("refuses the system behavior and unknown ids", async () => {
    const sys = await server.inject({ method: "POST", url: `/api/behaviors/${ids.login}/test` });
    expect(sys.statusCode).toBe(400);
    const missing = await server.inject({ method: "POST", url: "/api/behaviors/9999/test" });
    expect(missing.statusCode).toBe(404);
  });
});

describe("removed routes", () => {
  it("the scope tab API is gone", async () => {
    const res = await server.inject({ method: "GET", url: "/api/behavior-tabs" });
    expect(res.statusCode).toBe(404);
  });
});

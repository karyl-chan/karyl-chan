/**
 * The Behavior Target directory (ADR 0004):
 *
 *   - POST /api/behavior-targets creates a guild, channel, user or group
 *     target; it is listed at once, with no behavior
 *   - DELETE /api/behavior-targets/:id removes one nothing uses, and is
 *     refused (`target_in_use`) while a behavior or a DM allowlist does
 *   - every behavior write registers the target it leaves in use
 *   - GET /api/behaviors lists the targets in the sidebar's order and says
 *     which target each behavior belongs to
 */
import { vi, describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";

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
import { listAudit } from "../src/modules/admin/admin-audit.service.js";
import { BehaviorTarget } from "../src/modules/behavior/models/behavior-target.model.js";
import { BehaviorGroupMember } from "../src/modules/behavior/models/behavior-group-member.model.js";
import {
  clearBehaviors,
  seedBehaviorTarget,
  seedCommand,
  seedLeaf,
  seedMessageTrigger,
} from "./behavior-fixtures.js";

const GUILD = "111111111111111111";
const CHANNEL = "222222222222222222";
const USER = "333333333333333333";
const OTHER_GUILD = "444444444444444444";
/** A literal public address: a webhook URL is resolved when it is saved. */
const HOOK = "https://203.0.113.10/hook";

let server: FastifyInstance;

beforeAll(async () => {
  await sequelize.sync({ force: true });
});

beforeEach(async () => {
  await clearBehaviors();
  server = Fastify({ logger: false });
  server.addHook("onRequest", async (request) => {
    request.authUserId = "test";
    request.authCapabilities = new Set(["behavior.manage"]) as never;
  });
  await registerBehaviorRoutes(server);
  await server.ready();
});

afterEach(async () => {
  await server.close();
});

const create = (payload: Record<string, unknown>) =>
  server.inject({ method: "POST", url: "/api/behavior-targets", payload });
const remove = (id: number) => server.inject({ method: "DELETE", url: `/api/behavior-targets/${id}` });
const list = async () => (await server.inject({ method: "GET", url: "/api/behaviors" })).json();
const targetKeys = async (): Promise<string[]> =>
  ((await list()).targets as Array<{ key: string }>).map((t) => t.key);

describe("POST /api/behavior-targets", () => {
  it("creates each kind of target and lists it with no behavior", async () => {
    const guild = await create({ kind: "guild", guildId: GUILD });
    expect(guild.statusCode).toBe(201);
    expect(guild.json().target).toEqual({
      key: `guild:${GUILD}`,
      id: expect.any(Number),
      kind: "guild",
      builtin: false,
      guildId: GUILD,
      channelId: null,
      userId: null,
      groupName: null,
      memberCount: null,
      ownerOnly: false,
      allowlistRefs: 0,
    });
    expect((await create({ kind: "channel", guildId: GUILD, channelId: CHANNEL })).json().target).toMatchObject({
      key: `channel:${GUILD}:${CHANNEL}`,
      kind: "channel",
    });
    expect((await create({ kind: "user", userId: USER })).json().target).toMatchObject({
      key: `user:${USER}`,
      kind: "user",
      userId: USER,
    });
    expect((await create({ kind: "group", name: "  家人  " })).json().target).toMatchObject({
      key: "group:家人",
      kind: "group",
      groupName: "家人",
      memberCount: 0,
    });

    expect(await targetKeys()).toEqual([
      "app",
      "bot_dm",
      "guild:all",
      `guild:${GUILD}`,
      `channel:${GUILD}:${CHANNEL}`,
      "group:家人",
      `user:${USER}`,
    ]);
  });

  it("lets a new group take members right away", async () => {
    await create({ kind: "group", name: "vip" });
    const put = await server.inject({
      method: "PUT",
      url: "/api/behavior-groups/vip/members",
      payload: { userIds: [USER] },
    });
    expect(put.statusCode).toBe(200);
    const group = (await list()).targets.find((t: { key: string }) => t.key === "group:vip");
    expect(group).toMatchObject({ memberCount: 1 });
  });

  it("refuses a target that already exists", async () => {
    await create({ kind: "group", name: "vip" });
    const again = await create({ kind: "group", name: "vip" });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toMatchObject({ code: "name_conflict", field: "name" });

    await create({ kind: "user", userId: USER });
    expect((await create({ kind: "user", userId: USER })).json().error).toMatchObject({
      code: "name_conflict",
      field: "userId",
    });
  });

  it("refuses a field the kind does not take, and a missing one, naming the field", async () => {
    const extra = await create({ kind: "guild", guildId: GUILD, userId: USER });
    expect(extra.statusCode).toBe(400);
    expect(extra.json().error).toMatchObject({ code: "validation_failed", field: "userId" });

    const missing = await create({ kind: "channel", guildId: GUILD });
    expect(missing.json().error).toMatchObject({ code: "validation_failed", field: "channelId" });

    expect((await create({ kind: "group", name: "   " })).statusCode).toBe(400);
    expect((await create({ kind: "user", userId: "nope" })).statusCode).toBe(400);
    expect((await create({ kind: "role", userId: USER })).statusCode).toBe(400);
  });

  it("records the creation in admin_audit_log", async () => {
    await create({ kind: "group", name: "vip" });
    const [entry] = await listAudit({ limit: 1 });
    expect(entry).toMatchObject({
      actorUserId: "test",
      action: "behavior.target.create",
      target: "target:group:vip",
      context: { kind: "group", groupName: "vip" },
    });
  });
});

describe("DELETE /api/behavior-targets/:id", () => {
  it("deletes a target nothing uses, and a group's members with it", async () => {
    const id = (await create({ kind: "group", name: "vip" })).json().target.id as number;
    await BehaviorGroupMember.create({ groupName: "vip", userId: USER });

    const res = await remove(id);
    expect(res.statusCode).toBe(204);
    expect(await targetKeys()).toEqual(["app", "bot_dm", "guild:all"]);
    expect(await BehaviorGroupMember.count()).toBe(0);
    const [entry] = await listAudit({ limit: 1 });
    expect(entry).toMatchObject({ action: "behavior.target.delete", target: "target:group:vip" });

    expect((await remove(id)).statusCode).toBe(404);
  });

  it("refuses while a message trigger belongs to the target", async () => {
    const id = await seedBehaviorTarget(`user:${USER}`);
    const trigger = await seedMessageTrigger({ audienceKind: "user", audienceUserId: USER });

    const res = await remove(id);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({
      code: "target_in_use",
      details: { behaviors: 1, allowlists: 0 },
    });

    await server.inject({ method: "DELETE", url: `/api/behaviors/${trigger}` });
    expect((await remove(id)).statusCode).toBe(204);
  });

  it("refuses while a command is registered to the guild", async () => {
    const id = await seedBehaviorTarget(`guild:${GUILD}`);
    const command = await seedCommand({ registration: "guild", guildId: GUILD });
    await seedLeaf(command);
    expect((await remove(id)).json().error).toMatchObject({ code: "target_in_use" });
  });

  it("refuses a group a DM allowlist names, with no behavior of its own", async () => {
    const id = await seedBehaviorTarget("group:ops");
    const trigger = await seedMessageTrigger();
    await server.inject({
      method: "PUT",
      url: `/api/behaviors/${trigger}/dm-allowlist`,
      payload: { userIds: [], groupNames: ["ops"] },
    });

    const res = await remove(id);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({
      code: "target_in_use",
      details: { behaviors: 0, allowlists: 1 },
    });
    const group = (await list()).targets.find((t: { key: string }) => t.key === "group:ops");
    expect(group).toMatchObject({ allowlistRefs: 1 });
  });
});

describe("a behavior write registers the target it leaves in use", () => {
  const post = (payload: Record<string, unknown>) =>
    server.inject({
      method: "POST",
      url: "/api/behaviors",
      payload: { title: "t", patternKind: "startswith", patternValue: "!x", webhook: { url: HOOK }, ...payload },
    });

  it("a new trigger for a user, a group, a guild and a channel", async () => {
    expect((await post({ surface: "bot_dm", audienceKind: "user", audienceUserId: USER })).statusCode).toBe(201);
    expect((await post({ surface: "bot_dm", audienceKind: "group", audienceGroupName: "vip" })).statusCode).toBe(201);
    expect((await post({ surface: "guild", guildId: GUILD })).statusCode).toBe(201);
    expect((await post({ surface: "guild", guildId: OTHER_GUILD, channelId: CHANNEL })).statusCode).toBe(201);
    // everyone, in bot DMs and in all guilds: the built-in targets, no row
    expect((await post({ surface: "bot_dm" })).statusCode).toBe(201);
    expect((await post({ surface: "guild" })).statusCode).toBe(201);

    expect(await targetKeys()).toEqual([
      "app",
      "bot_dm",
      "guild:all",
      `guild:${GUILD}`,
      `channel:${OTHER_GUILD}:${CHANNEL}`,
      "group:vip",
      `user:${USER}`,
    ]);
  });

  it("a trigger moved to another target; the one it left stays", async () => {
    const created = await post({ surface: "bot_dm", audienceKind: "user", audienceUserId: USER });
    const id = created.json().behavior.id as number;
    expect(created.json().behavior).toMatchObject({ target: `user:${USER}`, section: "bot_dm" });

    const patched = await server.inject({
      method: "PATCH",
      url: `/api/behaviors/${id}`,
      payload: { audienceKind: "group", audienceUserId: null, audienceGroupName: "vip" },
    });
    expect(patched.json().behavior).toMatchObject({ target: "group:vip" });
    expect(await targetKeys()).toEqual(["app", "bot_dm", "guild:all", "group:vip", `user:${USER}`]);
  });

  it("refuses a group name with whitespace at its ends", async () => {
    const res = await post({ surface: "bot_dm", audienceKind: "group", audienceGroupName: " vip " });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatchObject({ field: "audienceGroupName" });
  });
});

describe("GET /api/behaviors", () => {
  it("registers a target in use that a write outside the routes left without a row", async () => {
    await seedMessageTrigger({ surface: "guild", guildId: GUILD });
    expect(await BehaviorTarget.count()).toBe(0);
    expect(await targetKeys()).toEqual(["app", "bot_dm", "guild:all", `guild:${GUILD}`]);
    expect(await BehaviorTarget.count()).toBe(1);
  });

  it("gives each behavior its target: a command's is its section", async () => {
    const command = await seedCommand({ registration: "guild", guildId: GUILD });
    await seedLeaf(command);
    await seedMessageTrigger({ title: "everyone" });
    await seedMessageTrigger({ title: "one user", audienceKind: "user", audienceUserId: USER });
    const body = await list();
    expect(body.commands.map((c: Record<string, unknown>) => [c.target, c.section])).toEqual([
      [`guild:${GUILD}`, `guild:${GUILD}`],
    ]);
    expect(body.messageTriggers.map((t: Record<string, unknown>) => [t.title, t.target, t.section])).toEqual([
      ["everyone", "bot_dm", "bot_dm"],
      ["one user", `user:${USER}`, "bot_dm"],
    ]);
  });

  it("serves the create schema with the other write schemas", async () => {
    const res = await server.inject({ method: "GET", url: "/api/behaviors/schema" });
    expect(res.json().target.properties.kind.enum).toEqual(["guild", "channel", "user", "group"]);
  });
});

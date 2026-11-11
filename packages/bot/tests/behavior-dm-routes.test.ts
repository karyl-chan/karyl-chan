/**
 * A behavior's DM allowlist and DM log, for the admin (#157):
 *
 *   - GET / PUT /api/behaviors/:id/dm-allowlist read and replace the list
 *     (empty: none), refused for the System Behavior, audited
 *   - a group a list names is in use: its members can be set, and it
 *     survives the prune that drops groups nobody uses; leaving the last
 *     list, or the behavior being deleted, prunes it
 *   - a command snapshot carries a leaf's list, so a refused command
 *     write puts it back
 *   - GET /api/behaviors/:id/dm-log returns the newest DMs; rows older
 *     than 30 days are pruned
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
import {
  findGroupMembers,
  pruneUnusedGroupMembers,
  replaceGroupMembers,
} from "../src/modules/behavior/models/behavior-group-member.model.js";
import { destroyDmAllowlists, findDmAllowlist } from "../src/modules/behavior/models/behavior-dm-allowlist.model.js";
import { BehaviorDefinition } from "../src/modules/behavior/models/behavior-definition.model.js";
import {
  DM_LOG_MAX_AGE_MS,
  findRecentDmLog,
  pruneDmLog,
  recordDmLog,
} from "../src/modules/behavior/behavior-dm-log.js";
import { destroyCommandRows, restoreCommand, snapshotCommand } from "../src/modules/behavior/command-snapshot.js";
import {
  clearBehaviors,
  seedCommand,
  seedLeaf,
  seedMessageTrigger,
  seedSystemLogin,
} from "./behavior-fixtures.js";

const U1 = "111111111111111111";
const U2 = "222222222222222222";

let server: FastifyInstance;

beforeAll(async () => {
  await sequelize.sync({ force: true });
});

beforeEach(async () => {
  await clearBehaviors();
  server = Fastify({ logger: false });
  server.addHook("onRequest", async (request) => {
    request.authUserId = "test";
    request.authCapabilities = new Set(["admin"]);
  });
  await registerBehaviorRoutes(server);
  await server.ready();
});

afterEach(async () => {
  await server.close();
});

const putList = (id: number, payload: unknown) =>
  server.inject({ method: "PUT", url: `/api/behaviors/${id}/dm-allowlist`, payload: payload as object });
const getList = (id: number) => server.inject({ method: "GET", url: `/api/behaviors/${id}/dm-allowlist` });
const putMembers = (group: string, userIds: string[]) =>
  server.inject({ method: "PUT", url: `/api/behavior-groups/${group}/members`, payload: { userIds } });

describe("the DM allowlist API", () => {
  it("reads an empty list, replaces it, reads it back, and clears it", async () => {
    const id = await seedMessageTrigger();
    expect((await getList(id)).json()).toEqual({ userIds: [], groupNames: [] });

    const put = await putList(id, { userIds: [U1, U2, U1], groupNames: [" ops "] });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toEqual({ userIds: [U1, U2], groupNames: ["ops"] });
    expect((await getList(id)).json()).toEqual({ userIds: [U1, U2], groupNames: ["ops"] });

    expect((await putList(id, { userIds: [], groupNames: [] })).json()).toEqual({ userIds: [], groupNames: [] });
    expect(await findDmAllowlist(id)).toBeNull();
  });

  it("records the replacement in admin_audit_log", async () => {
    const id = await seedMessageTrigger();
    await putList(id, { userIds: [U1], groupNames: [] });
    const [entry] = await listAudit({ limit: 1 });
    expect(entry).toMatchObject({
      action: "behavior.dm_allowlist.replace",
      target: `behavior:${id}`,
      context: { userIds: [U1], groupNames: [] },
    });
  });

  it("refuses bad ids, blank group names, and the System Behavior", async () => {
    const id = await seedMessageTrigger();
    expect((await putList(id, { userIds: ["nope"], groupNames: [] })).statusCode).toBe(400);
    expect((await putList(id, { userIds: [], groupNames: ["  "] })).statusCode).toBe(400);
    expect((await putList(id, { userIds: [] })).statusCode).toBe(400);
    const system = await seedSystemLogin();
    const res = await putList(system, { userIds: [U1], groupNames: [] });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("system_immutable");
    expect((await getList(9999)).statusCode).toBe(404);
  });
});

describe("a group a DM allowlist names", () => {
  it("is in use: its members can be set, and the prune keeps them", async () => {
    const id = await seedMessageTrigger();
    expect((await putMembers("ops", [U1])).statusCode).toBe(404);

    await putList(id, { userIds: [], groupNames: ["ops"] });
    const res = await putMembers("ops", [U1]);
    expect(res.statusCode).toBe(200);
    await sequelize.transaction((t) => pruneUnusedGroupMembers(t));
    expect(await findGroupMembers("ops")).toEqual([U1]);
  });

  it("is pruned when the last list drops it", async () => {
    const id = await seedMessageTrigger();
    await putList(id, { userIds: [], groupNames: ["ops"] });
    await putMembers("ops", [U1]);

    await putList(id, { userIds: [U2], groupNames: [] });
    expect(await findGroupMembers("ops")).toEqual([]);
  });

  it("goes with its behavior when the behavior is deleted, and so does its DM log", async () => {
    const id = await seedMessageTrigger();
    await putList(id, { userIds: [], groupNames: ["ops"] });
    await putMembers("ops", [U1]);
    await recordDmLog({ behaviorId: id, recipientUserId: U1, triggererUserId: U2, outcome: "sent" });

    const res = await server.inject({ method: "DELETE", url: `/api/behaviors/${id}` });
    expect(res.statusCode).toBe(204);
    expect(await findDmAllowlist(id)).toBeNull();
    expect(await findGroupMembers("ops")).toEqual([]);
    expect(await findRecentDmLog(id)).toEqual([]);
  });

  it("stays while a message trigger still uses it", async () => {
    const id = await seedMessageTrigger();
    await seedMessageTrigger({ title: "vip", audienceKind: "group", audienceGroupName: "ops" });
    await putList(id, { userIds: [], groupNames: ["ops"] });
    await putMembers("ops", [U1]);
    await putList(id, { userIds: [], groupNames: [] });
    expect(await findGroupMembers("ops")).toEqual([U1]);
  });
});

describe("a command leaf's DM allowlist", () => {
  it("goes with its command, and its group's members with it; its DM log ages out", async () => {
    const commandId = await seedCommand();
    const leaf = await seedLeaf(commandId);
    await putList(leaf, { userIds: [U1], groupNames: ["ops"] });
    await sequelize.transaction((t) => replaceGroupMembers("ops", [U2], t));
    await recordDmLog({ behaviorId: leaf, recipientUserId: U1, triggererUserId: U2, outcome: "sent" });

    await sequelize.transaction((t) => destroyCommandRows(commandId, t));
    expect(await findDmAllowlist(leaf)).toBeNull();
    expect(await findGroupMembers("ops")).toEqual([]);
    // kept for a refused write's restore; the 30-day prune removes it
    expect(await findRecentDmLog(leaf)).toHaveLength(1);
  });

  it("is in the command snapshot: a refused write puts it back", async () => {
    const commandId = await seedCommand();
    const leaf = await seedLeaf(commandId, { subcommand: "a" });
    await seedLeaf(commandId, { subcommand: "b" });
    await putList(leaf, { userIds: [U1], groupNames: ["ops"] });
    await recordDmLog({ behaviorId: leaf, recipientUserId: U1, triggererUserId: U2, outcome: "sent" });

    const snapshot = await snapshotCommand(commandId);
    // the write removed the leaf, then Discord refused it
    await sequelize.transaction(async (t) => {
      await destroyDmAllowlists(leaf, t);
      await BehaviorDefinition.destroy({ where: { id: leaf }, transaction: t });
    });
    await restoreCommand(snapshot);
    expect(await findDmAllowlist(leaf)).toEqual({ userIds: [U1], groupNames: ["ops"] });
    // its DM log was never removed
    expect((await findRecentDmLog(leaf)).map((e) => e.recipientUserId)).toEqual([U1]);
  });
});

describe("the DM log", () => {
  it("returns a behavior's DMs, newest first", async () => {
    const id = await seedMessageTrigger();
    const other = await seedMessageTrigger({ title: "other" });
    await recordDmLog({ behaviorId: id, recipientUserId: U1, triggererUserId: U2, outcome: "sent" });
    await recordDmLog({ behaviorId: id, recipientUserId: U2, triggererUserId: U2, outcome: "not_allowed" });
    await recordDmLog({ behaviorId: other, recipientUserId: U1, triggererUserId: U2, outcome: "sent" });

    const res = await server.inject({ method: "GET", url: `/api/behaviors/${id}/dm-log` });
    expect(res.statusCode).toBe(200);
    const { entries } = res.json() as { entries: Array<Record<string, unknown>> };
    expect(entries.map((e) => [e.recipientUserId, e.triggererUserId, e.outcome])).toEqual([
      [U2, U2, "not_allowed"],
      [U1, U2, "sent"],
    ]);
    expect(typeof entries[0]!.at).toBe("string");
  });

  it("keeps 30 days", async () => {
    const id = await seedMessageTrigger();
    const now = new Date("2026-11-10T00:00:00Z");
    await recordDmLog({
      behaviorId: id,
      recipientUserId: U1,
      triggererUserId: U2,
      outcome: "sent",
      at: new Date(now.getTime() - DM_LOG_MAX_AGE_MS - 1000),
    });
    await recordDmLog({
      behaviorId: id,
      recipientUserId: U2,
      triggererUserId: U2,
      outcome: "sent",
      at: new Date(now.getTime() - DM_LOG_MAX_AGE_MS + 60_000),
    });
    expect(await pruneDmLog(now)).toBe(1);
    const res = await server.inject({ method: "GET", url: `/api/behaviors/${id}/dm-log` });
    expect((res.json() as { entries: Array<{ recipientUserId: string }> }).entries.map((e) => e.recipientUserId)).toEqual([U2]);
  });
});

/**
 * #126 — the services page's API and the Service Behaviors it owns.
 *
 *   - a service comes and goes with its behavior row (a bot DM trigger on
 *     `!login-<audience>`, listed under `services` in GET /api/behaviors)
 *   - the row takes trigger edits only: deleting it, converting it,
 *     rotating a secret, changing its title or action are refused
 *   - a service trigger never takes the login's DMs, and the login's switch
 *     refuses a sample a service would take
 *   - the login row is untouched by all of it
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
import { sequelize } from "../src/db.js";
import { registerBehaviorRoutes } from "../src/modules/behavior/behavior-routes.js";
import { BehaviorDefinition } from "../src/modules/behavior/models/behavior-definition.model.js";
import { BehaviorGroupMember } from "../src/modules/behavior/models/behavior-group-member.model.js";
import { listAudit } from "../src/modules/admin/admin-audit.service.js";
import { clearBehaviors, seedMessageTrigger, seedSystemLogin } from "./behavior-fixtures.js";

const OWNER = "owner";
let server: FastifyInstance;
let capabilities: Set<string>;

beforeAll(async () => {
  await sequelize.sync({ force: true });
  server = Fastify({ logger: false });
  server.addHook("onRequest", async (request) => {
    request.authUserId = OWNER;
    request.authCapabilities = capabilities as never;
  });
  await registerBehaviorRoutes(server, { ownerIds: [OWNER] });
  await server.ready();
});

let loginId: number;
beforeEach(async () => {
  capabilities = new Set(["behavior.manage"]);
  await clearBehaviors();
  loginId = await seedSystemLogin();
});

const NAS = { name: "NAS", audience: "nas", redirectUrl: "https://nas.example/auth/karyl" };

async function createService(body: Record<string, unknown> = NAS) {
  return server.inject({ method: "POST", url: "/api/services", payload: body });
}

async function listView() {
  return (await server.inject({ method: "GET", url: "/api/behaviors" })).json();
}

async function serviceBehavior() {
  const { services } = await listView();
  return services[0] as Record<string, unknown> & { id: number; updatedAt: string };
}

describe("POST /api/services", () => {
  it("adds the service and its behavior: a bot DM trigger on !login-<audience>", async () => {
    const res = await createService();
    expect(res.statusCode).toBe(201);
    const { service } = res.json();
    expect(service).toMatchObject({
      ...NAS,
      id: expect.any(Number),
      behaviorId: expect.any(Number),
      trigger: { patternKind: "regex", patternValue: "^!login-nas$", audienceKind: "all" },
    });

    const view = await listView();
    expect(view.services).toEqual([
      expect.objectContaining({
        id: service.behaviorId,
        kind: "message",
        actionSource: "service",
        systemKey: null,
        surface: "bot_dm",
        section: "bot_dm",
        title: "登入 NAS",
        patternKind: "regex",
        patternValue: "^!login-nas$",
        stopOnMatch: true,
        webhook: null,
        service: { id: service.id, ...NAS },
      }),
    ]);
    // not a custom trigger, and the login is still the system row
    expect(view.messageTriggers).toEqual([]);
    expect(view.system).toMatchObject({ id: loginId, systemKey: "admin-login", patternValue: "!login" });
  });

  it("refuses an audience in use, a non-https URL, credentials or a token parameter", async () => {
    await createService();
    expect((await createService({ ...NAS, name: "Other" })).json().error).toMatchObject({
      code: "name_conflict",
      field: "audience",
    });
    for (const redirectUrl of [
      "http://nas.example/cb",
      "https://user:pw@nas.example/cb",
      "https://nas.example/cb?token=x",
      "not a url",
    ]) {
      const res = await createService({ ...NAS, audience: "other", redirectUrl });
      expect(res.statusCode, redirectUrl).toBe(400);
      expect(res.json().error).toMatchObject({ code: "validation_failed", field: "redirectUrl" });
    }
  });

  it("refuses an audience that is not a slug", async () => {
    for (const audience of ["NAS", "-nas", "nas-", "n a s", "a".repeat(65)]) {
      const res = await createService({ ...NAS, audience });
      expect(res.statusCode, audience).toBe(400);
      expect(res.json().error).toMatchObject({ field: "audience" });
    }
  });

  it("needs behavior.manage (or admin)", async () => {
    capabilities = new Set();
    expect((await createService()).statusCode).toBe(403);
    expect((await server.inject({ method: "GET", url: "/api/services" })).statusCode).toBe(403);
    capabilities = new Set(["admin"]);
    expect((await createService()).statusCode).toBe(201);
  });

  it("is audited", async () => {
    const { service } = (await createService()).json();
    const entry = (await listAudit({ limit: 20 })).find(
      (e) => e.action === "behavior.service.create" && e.target === `service:${service.id}`,
    );
    expect(entry?.context).toMatchObject({ audience: "nas", behaviorId: service.behaviorId });
  });
});

describe("PUT /api/services/:id", () => {
  it("renames the service and its behavior's title", async () => {
    const { service } = (await createService()).json();
    const res = await server.inject({
      method: "PUT",
      url: `/api/services/${service.id}`,
      payload: { name: "Home NAS", ifUpdatedAt: service.updatedAt },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().service).toMatchObject({ name: "Home NAS", audience: "nas" });
    expect(await serviceBehavior()).toMatchObject({ title: "登入 Home NAS" });
  });

  it("moves a default trigger with the audience; keeps one the admin changed", async () => {
    const { service } = (await createService()).json();
    let res = await server.inject({ method: "PUT", url: `/api/services/${service.id}`, payload: { audience: "storage" } });
    expect(res.json().service.trigger).toMatchObject({ patternValue: "^!login-storage$" });

    const row = await serviceBehavior();
    await server.inject({ method: "PATCH", url: `/api/behaviors/${row.id}`, payload: { patternKind: "startswith", patternValue: "!nas" } });
    res = await server.inject({ method: "PUT", url: `/api/services/${service.id}`, payload: { audience: "files" } });
    expect(res.json().service).toMatchObject({
      audience: "files",
      trigger: { patternKind: "startswith", patternValue: "!nas" },
    });
  });

  it("refuses a stale edit, a taken audience, an http URL; 404 for no such service", async () => {
    const { service } = (await createService()).json();
    await createService({ ...NAS, audience: "wiki" });
    const put = (payload: Record<string, unknown>, id = service.id) =>
      server.inject({ method: "PUT", url: `/api/services/${id}`, payload });
    expect((await put({ name: "x", ifUpdatedAt: "2000-01-01T00:00:00.000Z" })).statusCode).toBe(409);
    expect((await put({ audience: "wiki" })).json().error).toMatchObject({ code: "name_conflict" });
    expect((await put({ redirectUrl: "http://nas.example" })).statusCode).toBe(400);
    expect((await put({ name: "x" }, 9999)).statusCode).toBe(404);
    // its own audience is not "taken"
    expect((await put({ audience: "nas" })).statusCode).toBe(200);
  });
});

describe("DELETE /api/services/:id", () => {
  it("removes the service, its behavior, and a group only it used", async () => {
    const { service } = (await createService()).json();
    const row = await serviceBehavior();
    await server.inject({
      method: "PATCH",
      url: `/api/behaviors/${row.id}`,
      payload: { audienceKind: "group", audienceGroupName: "family" },
    });
    await BehaviorGroupMember.create({ groupName: "family", userId: "U1" });

    const res = await server.inject({ method: "DELETE", url: `/api/services/${service.id}` });
    expect(res.statusCode).toBe(204);
    expect((await listView()).services).toEqual([]);
    expect(await BehaviorDefinition.count({ where: { actionSource: "service" } })).toBe(0);
    expect(await BehaviorGroupMember.count()).toBe(0);
    expect((await server.inject({ method: "GET", url: "/api/services" })).json().services).toEqual([]);
    expect((await server.inject({ method: "DELETE", url: `/api/services/${service.id}` })).statusCode).toBe(404);
  });
});

describe("the service's behavior row: its trigger only", () => {
  it("takes a pattern and an audience", async () => {
    await createService();
    const row = await serviceBehavior();
    const res = await server.inject({
      method: "PATCH",
      url: `/api/behaviors/${row.id}`,
      payload: {
        patternKind: "startswith",
        patternValue: "!nas",
        audienceKind: "user",
        audienceUserId: "123456789012345678",
        ifUpdatedAt: row.updatedAt,
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().behavior).toMatchObject({
      id: row.id,
      patternKind: "startswith",
      patternValue: "!nas",
      audienceKind: "user",
      audienceUserId: "123456789012345678",
      service: { audience: "nas" },
    });
  });

  it("refuses anything else: title, enabled, location, stop flag, visibility, a webhook", async () => {
    await createService();
    const row = await serviceBehavior();
    for (const payload of [
      { title: "mine" },
      { description: "note" },
      { enabled: false },
      { surface: "guild" },
      { stopOnMatch: false },
      { replyVisibility: "public" },
      { webhook: { url: "https://hooks.example/x", authMode: null } },
    ]) {
      const res = await server.inject({ method: "PATCH", url: `/api/behaviors/${row.id}`, payload });
      expect(res.statusCode, JSON.stringify(payload)).toBe(409);
      expect(res.json().error).toMatchObject({ code: "system_immutable", field: Object.keys(payload)[0] });
    }
    expect(await serviceBehavior()).toMatchObject({ title: "登入 NAS", enabled: true, surface: "bot_dm" });
  });

  it("refuses deleting, converting it, rotating a secret, reordering it", async () => {
    await createService();
    const row = await serviceBehavior();
    const del = await server.inject({ method: "DELETE", url: `/api/behaviors/${row.id}` });
    expect(del.statusCode).toBe(409);
    expect(del.json().error.code).toBe("system_immutable");
    const convert = await server.inject({
      method: "POST",
      url: `/api/behaviors/${row.id}/convert-trigger`,
      payload: {
        to: "command",
        command: { new: { name: "nas", registration: "global", integrationTypes: ["guild_install"], contexts: ["BotDM"] } },
        ifUpdatedAt: row.updatedAt,
      },
    });
    expect(convert.json().error.code).toBe("system_immutable");
    const rotate = await server.inject({ method: "POST", url: `/api/behaviors/${row.id}/webhook-secret/rotate` });
    expect(rotate.json().error.code).toBe("system_immutable");
    const reorder = await server.inject({
      method: "PUT",
      url: "/api/behaviors/reorder",
      payload: { location: "bot_dm", ids: [row.id] },
    });
    expect(reorder.json().error.code).toBe("system_immutable");
    expect((await listView()).services).toHaveLength(1);
  });

  it("stays out of a bot DM reorder, and keeps its place before the login", async () => {
    await createService();
    const a = await seedMessageTrigger({ title: "a", sortOrder: 0 });
    const b = await seedMessageTrigger({ title: "b", sortOrder: 1 });
    const res = await server.inject({
      method: "PUT",
      url: "/api/behaviors/reorder",
      payload: { location: "bot_dm", ids: [b, a] },
    });
    expect(res.statusCode).toBe(200);
    const view = await listView();
    expect(view.messageTriggers.map((t: { id: number }) => t.id)).toEqual([b, a]);
    expect(view.services[0].sortOrder).toBeLessThan(view.system.sortOrder);
  });

  it("never takes the login's DMs", async () => {
    await createService();
    const row = await serviceBehavior();
    for (const payload of [
      { patternKind: "startswith", patternValue: "!" },
      { patternKind: "regex", patternValue: "^!log" },
    ]) {
      const res = await server.inject({ method: "PATCH", url: `/api/behaviors/${row.id}`, payload });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      expect(res.json().error).toMatchObject({ code: "validation_failed", field: "patternValue" });
    }
  });

  it("the login's switch refuses a sample a service would take", async () => {
    await createService();
    const res = await server.inject({
      method: "PUT",
      url: "/api/behaviors/system/login/trigger",
      payload: { kind: "message", patternKind: "startswith", patternValue: "!login-nas", sample: "!login-nas" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatchObject({ code: "validation_failed", field: "sample" });
    // a sample clear of the services goes through
    const ok = await server.inject({
      method: "PUT",
      url: "/api/behaviors/system/login/trigger",
      payload: { kind: "message", patternKind: "startswith", patternValue: "!admin", sample: "!admin" },
    });
    expect(ok.statusCode).toBe(200);
  });
});

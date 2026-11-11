/**
 * #126 — the services page's API and the Service Behaviors it owns.
 *
 *   - owner only: a service's redirect URL receives its users' tokens
 *   - a service comes and goes with its behavior row (a bot DM trigger on
 *     `!login-<audience>`, listed under `services` in GET /api/behaviors)
 *   - the row takes only its trigger switch (PUT /api/services/:id/trigger),
 *     the login's register-first flow: a bot DM pattern with an audience,
 *     or a global command; every other behavior write refuses it
 *   - no service trigger takes the login's DMs or another service's, and
 *     the login's switch keeps the same invariant from its side
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

import type { Client } from "discord.js";
import Fastify, { type FastifyInstance } from "fastify";
import { sequelize } from "../src/db.js";
import { registerBehaviorRoutes } from "../src/modules/behavior/behavior-routes.js";
import { BehaviorCommand } from "../src/modules/behavior/models/behavior-command.model.js";
import { BehaviorDefinition } from "../src/modules/behavior/models/behavior-definition.model.js";
import { BehaviorGroupMember } from "../src/modules/behavior/models/behavior-group-member.model.js";
import { listAudit } from "../src/modules/admin/admin-audit.service.js";
import { CommandNamespace } from "../src/modules/command-system/command-namespace.js";
import { CommandReconciler } from "../src/modules/command-system/reconcile.service.js";
import { clearBehaviors, seedMessageTrigger, seedSystemLogin } from "./behavior-fixtures.js";

const OWNER = "owner";

// a Discord that keeps the registered global commands
const discord = new Map<string, { id: string; name: string }>();
class FakeCollection extends Map<string, { id: string; name: string }> {
  find(fn: (v: { id: string; name: string }) => boolean) {
    for (const v of this.values()) if (fn(v)) return v;
    return undefined;
  }
}
const commands = {
  fetch: async () => new FakeCollection(discord),
  create: vi.fn(async (data: { name: string }) => {
    const cmd = { id: `c${discord.size + 1}`, name: data.name };
    discord.set(cmd.id, cmd);
    return cmd;
  }),
  edit: async () => undefined,
  delete: async (id: string) => {
    discord.delete(id);
  },
};
const reconciler = new CommandReconciler(
  () => ({ application: { commands }, guilds: { cache: new Map() } }) as unknown as Client,
);

let server: FastifyInstance;
let caller: { userId: string; capabilities: Set<string> };

beforeAll(async () => {
  await sequelize.sync({ force: true });
  server = Fastify({ logger: false });
  server.addHook("onRequest", async (request) => {
    request.authUserId = caller.userId;
    request.authCapabilities = caller.capabilities as never;
  });
  await registerBehaviorRoutes(server, {
    ownerIds: [OWNER],
    reconciler,
    namespace: new CommandNamespace(),
  });
  await server.ready();
});

let loginId: number;
beforeEach(async () => {
  caller = { userId: OWNER, capabilities: new Set(["behavior.manage"]) };
  discord.clear();
  commands.create.mockClear();
  await clearBehaviors();
  loginId = await seedSystemLogin();
});

const NAS = { name: "NAS", audience: "nas", redirectUrl: "https://nas.example/auth/karyl" };
const TO_COMMAND = {
  kind: "command",
  name: "nas-login",
  description: "Log in to the NAS",
  integrationTypes: ["guild_install"],
  contexts: ["BotDM", "Guild"],
};

async function createService(body: Record<string, unknown> = NAS) {
  return server.inject({ method: "POST", url: "/api/services", payload: body });
}

async function created(body: Record<string, unknown> = NAS): Promise<{ id: number; behaviorId: number; updatedAt: string }> {
  const res = await createService(body);
  expect(res.statusCode).toBe(201);
  return res.json().service;
}

function switchTrigger(serviceId: number, payload: Record<string, unknown>) {
  return server.inject({ method: "PUT", url: `/api/services/${serviceId}/trigger`, payload });
}

async function listView() {
  return (await server.inject({ method: "GET", url: "/api/behaviors" })).json();
}

describe("POST /api/services", () => {
  it("adds the service and its behavior: a bot DM trigger on !login-<audience>", async () => {
    const service = await created();
    expect(service).toMatchObject({
      ...NAS,
      behaviorId: expect.any(Number),
      trigger: { kind: "message", patternKind: "regex", patternValue: "^!login-nas$", audienceKind: "all" },
    });

    const view = await listView();
    expect(view.services).toEqual([
      expect.objectContaining({
        id: service.behaviorId,
        kind: "message",
        actionSource: "service",
        systemKey: null,
        section: "bot_dm",
        title: "登入 NAS",
        patternValue: "^!login-nas$",
        stopOnMatch: true,
        webhook: null,
        service: { id: service.id, ...NAS },
      }),
    ]);
    expect(view.messageTriggers).toEqual([]);
    expect(view.system).toMatchObject({ id: loginId, systemKey: "admin-login", patternValue: "!login" });
  });

  it("refuses an audience in use, a non-https URL, credentials or a token parameter", async () => {
    await created();
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
    expect((await createService({ ...NAS, audience: "x", redirectUrl: "http://x.example" })).json().error.message).toContain(
      "service token",
    );
  });

  it("refuses an audience that is not a slug", async () => {
    for (const audience of ["NAS", "-nas", "nas-", "n a s", "a".repeat(65)]) {
      const res = await createService({ ...NAS, audience });
      expect(res.statusCode, audience).toBe(400);
      expect(res.json().error).toMatchObject({ field: "audience" });
    }
  });

  it("is audited", async () => {
    const service = await created();
    const entry = (await listAudit({ limit: 20 })).find(
      (e) => e.action === "behavior.service.create" && e.target === `service:${service.id}`,
    );
    expect(entry?.context).toMatchObject({ audience: "nas", behaviorId: service.behaviorId });
  });
});

describe("owner only", () => {
  it("refuses an admin who is not the owner every services route and the trigger switch", async () => {
    const service = await created();
    caller = { userId: "admin", capabilities: new Set(["admin"]) };
    const routes = [
      { method: "GET", url: "/api/services" },
      { method: "POST", url: "/api/services", payload: { ...NAS, audience: "wiki" } },
      { method: "PUT", url: `/api/services/${service.id}`, payload: { redirectUrl: "https://evil.example/cb" } },
      { method: "DELETE", url: `/api/services/${service.id}` },
      { method: "PUT", url: `/api/services/${service.id}/trigger`, payload: { kind: "message", patternKind: "startswith", patternValue: "!nas" } },
    ] as const;
    for (const route of routes) {
      const res = await server.inject(route as never);
      expect(res.statusCode, `${route.method} ${route.url}`).toBe(403);
    }
    // the behaviors page still lists it (read-only), and it is unchanged
    expect((await listView()).services[0]).toMatchObject({ service: { redirectUrl: NAS.redirectUrl } });
  });

  it("a group a service trigger uses: only an owner sets its members", async () => {
    const service = await created();
    await switchTrigger(service.id, {
      kind: "message",
      patternKind: "regex",
      patternValue: "^!login-nas$",
      audienceKind: "group",
      audienceGroupName: "family",
    });
    await seedMessageTrigger({ title: "ops", audienceKind: "group", audienceGroupName: "ops" });
    const put = (group: string) =>
      server.inject({
        method: "PUT",
        url: `/api/behavior-groups/${group}/members`,
        payload: { userIds: ["123456789012345678"] },
      });

    caller = { userId: "admin", capabilities: new Set(["behavior.manage"]) };
    expect((await put("family")).statusCode).toBe(403);
    expect(await BehaviorGroupMember.count({ where: { groupName: "family" } })).toBe(0);
    // a group only ordinary triggers use stays behavior.manage's
    expect((await put("ops")).statusCode).toBe(200);
    // reading it is fine
    expect((await server.inject({ method: "GET", url: "/api/behavior-groups/family/members" })).statusCode).toBe(200);

    caller = { userId: OWNER, capabilities: new Set(["behavior.manage"]) };
    expect((await put("family")).json()).toEqual({ groupName: "family", members: ["123456789012345678"] });
  });

  it("needs behavior.manage (or admin) before that", async () => {
    caller = { userId: OWNER, capabilities: new Set() };
    expect((await createService()).statusCode).toBe(403);
  });
});

describe("PUT /api/services/:id", () => {
  it("renames the service and its behavior's title", async () => {
    const service = await created();
    const res = await server.inject({
      method: "PUT",
      url: `/api/services/${service.id}`,
      payload: { name: "Home NAS", ifUpdatedAt: service.updatedAt },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().service).toMatchObject({ name: "Home NAS", audience: "nas" });
    expect((await listView()).services[0]).toMatchObject({ title: "登入 Home NAS" });
  });

  it("moves a default trigger with the audience; keeps one the owner changed", async () => {
    const service = await created();
    let res = await server.inject({ method: "PUT", url: `/api/services/${service.id}`, payload: { audience: "storage" } });
    expect(res.json().service.trigger).toMatchObject({ patternValue: "^!login-storage$" });

    await switchTrigger(service.id, { kind: "message", patternKind: "startswith", patternValue: "!nas" });
    res = await server.inject({ method: "PUT", url: `/api/services/${service.id}`, payload: { audience: "files" } });
    expect(res.json().service).toMatchObject({
      audience: "files",
      trigger: { patternKind: "startswith", patternValue: "!nas" },
    });
  });

  it("refuses a stale edit, a taken audience, an http URL; 404 for no such service", async () => {
    const service = await created();
    await created({ ...NAS, audience: "wiki" });
    const put = (payload: Record<string, unknown>, id = service.id) =>
      server.inject({ method: "PUT", url: `/api/services/${id}`, payload });
    expect((await put({ name: "x", ifUpdatedAt: "2000-01-01T00:00:00.000Z" })).statusCode).toBe(409);
    expect((await put({ audience: "wiki" })).json().error).toMatchObject({ code: "name_conflict" });
    expect((await put({ redirectUrl: "http://nas.example" })).statusCode).toBe(400);
    expect((await put({ name: "x" }, 9999)).statusCode).toBe(404);
    expect((await put({ audience: "nas" })).statusCode).toBe(200);
  });
});

describe("DELETE /api/services/:id", () => {
  it("removes the service, its behavior, and a group only it used", async () => {
    const service = await created();
    await switchTrigger(service.id, {
      kind: "message",
      patternKind: "regex",
      patternValue: "^!login-nas$",
      audienceKind: "group",
      audienceGroupName: "family",
    });
    await BehaviorGroupMember.create({ groupName: "family", userId: "U1" });

    const res = await server.inject({ method: "DELETE", url: `/api/services/${service.id}` });
    expect(res.statusCode).toBe(204);
    expect((await listView()).services).toEqual([]);
    expect(await BehaviorDefinition.count({ where: { actionSource: "service" } })).toBe(0);
    expect(await BehaviorGroupMember.count()).toBe(0);
    expect((await server.inject({ method: "DELETE", url: `/api/services/${service.id}` })).statusCode).toBe(404);
  });

  it("takes a command trigger off Discord too", async () => {
    const service = await created();
    expect((await switchTrigger(service.id, TO_COMMAND)).statusCode).toBe(200);
    expect([...discord.values()].map((c) => c.name)).toEqual(["nas-login"]);
    const res = await server.inject({ method: "DELETE", url: `/api/services/${service.id}` });
    expect(res.json()).toEqual({ registration: { status: "removed" } });
    expect(discord.size).toBe(0);
    expect(await BehaviorCommand.count()).toBe(0);
  });
});

describe("PUT /api/services/:id/trigger", () => {
  it("takes a pattern and an audience", async () => {
    const service = await created();
    const res = await switchTrigger(service.id, {
      kind: "message",
      patternKind: "startswith",
      patternValue: "!nas",
      audienceKind: "user",
      audienceUserId: "123456789012345678",
      ifUpdatedAt: (await listView()).services[0].updatedAt,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      registration: null,
      behavior: {
        id: service.behaviorId,
        kind: "message",
        patternKind: "startswith",
        patternValue: "!nas",
        audienceKind: "user",
        audienceUserId: "123456789012345678",
        service: { audience: "nas" },
      },
    });
  });

  it("switches to a command — registered first — and back to a message", async () => {
    const service = await created();
    let res = await switchTrigger(service.id, TO_COMMAND);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      registration: { status: "registered" },
      behavior: { kind: "command", name: "nas-login", isSystem: true, section: "app", service: { audience: "nas" } },
    });
    const view = await listView();
    expect(view.commands).toEqual([]);
    expect(view.services[0]).toMatchObject({ kind: "command", leaves: [{ id: service.behaviorId, actionSource: "service" }] });
    expect((await server.inject({ method: "GET", url: "/api/services" })).json().services[0].trigger).toEqual({
      kind: "command",
      name: "nas-login",
    });

    res = await switchTrigger(service.id, { kind: "message", patternKind: "regex", patternValue: "^!login-nas$" });
    expect(res.json()).toMatchObject({ registration: { status: "removed" }, behavior: { kind: "message", section: "bot_dm" } });
    expect(discord.size).toBe(0);
    expect(await BehaviorCommand.count()).toBe(0);
  });

  it("a refused registration keeps the message trigger", async () => {
    const service = await created();
    commands.create.mockRejectedValueOnce(new Error("Missing Access"));
    const res = await switchTrigger(service.id, TO_COMMAND);
    expect(res.statusCode).toBe(502);
    expect((await listView()).services[0]).toMatchObject({ kind: "message", patternValue: "^!login-nas$" });
  });

  it("refuses /login, a name in use, a guild-channel location, the other kind's fields", async () => {
    const service = await created();
    expect((await switchTrigger(service.id, { ...TO_COMMAND, name: "login" })).json().error).toMatchObject({
      code: "name_conflict",
      field: "name",
    });
    const other = await created({ ...NAS, audience: "wiki" });
    await switchTrigger(other.id, TO_COMMAND);
    expect((await switchTrigger(service.id, TO_COMMAND)).json().error).toMatchObject({ code: "name_conflict" });
    expect((await switchTrigger(service.id, { kind: "message", patternKind: "startswith", patternValue: "!x", surface: "guild" })).statusCode).toBe(400);
    expect((await switchTrigger(service.id, { kind: "message", patternKind: "startswith", patternValue: "!x", name: "x" })).json().error).toMatchObject({ field: "name" });
  });

  it("is audited with its outcome", async () => {
    const service = await created();
    await switchTrigger(service.id, TO_COMMAND);
    const entry = (await listAudit({ limit: 20 })).find(
      (e) => e.action === "behavior.service.trigger" && e.target === `service:${service.id}`,
    );
    expect(entry?.context).toMatchObject({
      from: { kind: "message", patternValue: "^!login-nas$" },
      to: { kind: "command", name: "nas-login" },
      outcome: "switched",
    });
  });
});

describe("the service's behavior row takes no other write", () => {
  it("refuses PATCH, DELETE, convert, secret rotation and reorder", async () => {
    const service = await created();
    const row = (await listView()).services[0];
    for (const payload of [{ title: "mine" }, { enabled: false }, { patternValue: "!nas" }]) {
      const res = await server.inject({ method: "PATCH", url: `/api/behaviors/${row.id}`, payload });
      expect(res.statusCode, JSON.stringify(payload)).toBe(409);
      expect(res.json().error.code).toBe("system_immutable");
    }
    expect((await server.inject({ method: "DELETE", url: `/api/behaviors/${row.id}` })).json().error.code).toBe("system_immutable");
    const convert = await server.inject({
      method: "POST",
      url: `/api/behaviors/${row.id}/convert-trigger`,
      payload: { to: "command", command: { new: { name: "nas", registration: "global", integrationTypes: ["guild_install"], contexts: ["BotDM"] } }, ifUpdatedAt: row.updatedAt },
    });
    expect(convert.json().error.code).toBe("system_immutable");
    expect((await server.inject({ method: "POST", url: `/api/behaviors/${row.id}/webhook-secret/rotate` })).json().error.code).toBe("system_immutable");
    const reorder = await server.inject({ method: "PUT", url: "/api/behaviors/reorder", payload: { location: "bot_dm", ids: [row.id] } });
    expect(reorder.json().error.code).toBe("system_immutable");
    expect((await listView()).services).toHaveLength(1);
    expect(service.behaviorId).toBe(row.id);
  });

  it("its command is refused by the command routes", async () => {
    const service = await created();
    const { behavior } = (await switchTrigger(service.id, TO_COMMAND)).json();
    const del = await server.inject({ method: "DELETE", url: `/api/behavior-commands/${behavior.id}` });
    expect(del.json().error.code).toBe("system_immutable");
    const patch = await server.inject({ method: "PATCH", url: `/api/behavior-commands/${behavior.id}`, payload: { description: "x" } });
    expect(patch.json().error.code).toBe("system_immutable");
  });

  it("stays out of a bot DM reorder, and keeps its place before the login", async () => {
    await created();
    const a = await seedMessageTrigger({ title: "a", sortOrder: 0 });
    const b = await seedMessageTrigger({ title: "b", sortOrder: 1 });
    const res = await server.inject({ method: "PUT", url: "/api/behaviors/reorder", payload: { location: "bot_dm", ids: [b, a] } });
    expect(res.statusCode).toBe(200);
    const view = await listView();
    expect(view.messageTriggers.map((t: { id: number }) => t.id)).toEqual([b, a]);
    expect(view.services[0].sortOrder).toBeLessThan(view.system.sortOrder);
  });
});

describe("no trigger shadows a fixed row", () => {
  it("a service trigger never takes the login's DMs", async () => {
    const service = await created();
    for (const [patternKind, patternValue] of [["startswith", "!"], ["regex", "^!log"]]) {
      const res = await switchTrigger(service.id, { kind: "message", patternKind, patternValue });
      expect(res.statusCode, patternValue).toBe(400);
      expect(res.json().error).toMatchObject({ code: "validation_failed", field: "patternValue" });
    }
  });

  it("the login's switch refuses a pattern or a sample a service would take", async () => {
    const service = await created();
    await switchTrigger(service.id, { kind: "message", patternKind: "startswith", patternValue: "!nas" });
    const login = (payload: Record<string, unknown>) =>
      server.inject({ method: "PUT", url: "/api/behaviors/system/login/trigger", payload });
    // the pattern text itself would go to the service
    expect((await login({ kind: "message", patternKind: "startswith", patternValue: "!nas", sample: "!nas" })).json().error).toMatchObject({
      field: "patternValue",
    });
    // the pattern is clear, the sample is not
    expect((await login({ kind: "message", patternKind: "endswith", patternValue: "please", sample: "!nas please" })).json().error).toMatchObject({
      field: "sample",
    });
    expect((await login({ kind: "message", patternKind: "startswith", patternValue: "!admin", sample: "!admin" })).statusCode).toBe(200);
  });

  it("a service trigger never takes another service's DMs, in either save order", async () => {
    const nas = await created();
    // a prefix that would answer `!login-nas` first
    const wiki = await created({ ...NAS, audience: "wiki" });
    const res = await switchTrigger(wiki.id, { kind: "message", patternKind: "startswith", patternValue: "!login-" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('service "NAS"');

    // a service whose own sample DM an existing trigger would answer
    await switchTrigger(nas.id, { kind: "message", patternKind: "startswith", patternValue: "!files" });
    expect((await createService({ ...NAS, audience: "x" })).statusCode).toBe(201);
    const files = await created({ ...NAS, audience: "files" });
    const clash = await switchTrigger(files.id, { kind: "message", patternKind: "startswith", patternValue: "!files-backup" });
    expect(clash.statusCode).toBe(400);
    expect(clash.json().error.message).toContain('service "NAS"');
  });
});

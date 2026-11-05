/**
 * #139 — PUT /api/behaviors/system/login/trigger: the System Behavior
 * (login) switches between a bot DM Message Trigger and a Command.
 *
 *   - message → command: the name is checked, the command registered on
 *     Discord, and only then stored; a refusal changes nothing, a failed
 *     DB write takes the fresh registration back off Discord
 *   - command → message: stored first, then the command is deleted from
 *     Discord; a deletion Discord refuses is logged and left to reconcile
 *   - at no step is the login left without a working trigger
 *
 * Discord is a stateful fake behind a real CommandReconciler; the
 * namespace is the real CommandNamespace over the same database.
 *
 * Runs on in-memory SQLite. Set TEST_PG_SCRATCH_URL to also run it on
 * Postgres — the in-place conversion of the system row (message trigger ⇄
 * command leaf) and its transactions then run there. The database at that
 * URL is WIPED (its public schema is dropped): point it at a throwaway one.
 */
import { vi, describe, it, expect, beforeAll, beforeEach } from "vitest";

vi.hoisted(() => {
  process.env.SQLITE_DB_PATH = ":memory:";
  process.env.ENCRYPTION_KEY = "a".repeat(64);
  process.env.DB_URL = process.env.TEST_PG_SCRATCH_URL ?? "";
});

vi.mock("../src/modules/bot-events/bot-event-log.js", () => ({
  botEventLog: { record: vi.fn() },
}));

import type { Client } from "discord.js";
import Fastify, { type FastifyInstance } from "fastify";
import type { QueryInterface } from "sequelize";
import { dbDialect, sequelize } from "../src/db.js";
import { up as indexes011 } from "../src/migrations/011-behavior-trigger-action-tables.js";
import { registerBehaviorRoutes } from "../src/modules/behavior/behavior-routes.js";
import { listAudit } from "../src/modules/admin/admin-audit.service.js";
import { botEventLog } from "../src/modules/bot-events/bot-event-log.js";
import { BehaviorCommand } from "../src/modules/behavior/models/behavior-command.model.js";
import { BehaviorDefinition } from "../src/modules/behavior/models/behavior-definition.model.js";
import { PluginCommand } from "../src/modules/plugin-system/models/plugin-command.model.js";
import { ReconcilerOwnedCommand } from "../src/modules/command-system/models/reconciler-owned-command.model.js";
import { CommandReconciler } from "../src/modules/command-system/reconcile.service.js";
import { CommandNamespace } from "../src/modules/command-system/command-namespace.js";
import { clearBehaviors, seedCommand, seedLeaf, seedSystemLogin } from "./behavior-fixtures.js";

// ── fake Discord ────────────────────────────────────────────────────────────

interface CmdStub {
  id: string;
  name: string;
  description: string;
  contexts?: unknown;
}

class FakeCollection extends Map<string, CmdStub> {
  find(fn: (v: CmdStub) => boolean): CmdStub | undefined {
    for (const v of this.values()) if (fn(v)) return v;
    return undefined;
  }
}

function fakeCommands() {
  const store = new Map<string, CmdStub>();
  let idc = 0;
  return {
    store,
    names: () => [...store.values()].map((c) => c.name).sort(),
    byName: (name: string) => [...store.values()].find((c) => c.name === name),
    fetch: vi.fn(async () => new FakeCollection(store)),
    create: vi.fn(async (data: CmdStub) => {
      const cmd = { ...data, id: `c${++idc}` };
      store.set(cmd.id, cmd);
      return cmd;
    }),
    edit: vi.fn(async (id: string, data: CmdStub) => {
      store.set(id, { ...data, id });
      return store.get(id);
    }),
    delete: vi.fn(async (id: string) => {
      store.delete(id);
    }),
  };
}

const globalCmds = fakeCommands();
let botReady = true;
const reconciler = new CommandReconciler(() =>
  botReady
    ? ({
        application: { commands: globalCmds },
        guilds: { cache: new Map() },
      } as unknown as Client)
    : null,
);

let server: FastifyInstance;
let capabilities = ["behavior.manage"];

const OWNER = "111111111111111111";

beforeAll(async () => {
  if (dbDialect === "postgres") {
    await sequelize.query("DROP SCHEMA public CASCADE");
    await sequelize.query("CREATE SCHEMA public");
  }
  await sequelize.sync({ force: true });
  // the partial unique indexes (command names, the one system key) as production has them
  await (indexes011 as (c: { context: QueryInterface }) => Promise<void>)({
    context: sequelize.getQueryInterface(),
  });
  server = Fastify({ logger: false });
  server.addHook("onRequest", async (request) => {
    request.authUserId = OWNER;
    request.authCapabilities = new Set(capabilities) as never;
  });
  await registerBehaviorRoutes(server, {
    reconciler,
    namespace: new CommandNamespace(),
    ownerIds: [OWNER],
  });
  await server.ready();
});

let systemId: number;

beforeEach(async () => {
  vi.mocked(botEventLog.record).mockClear();
  await clearBehaviors();
  await PluginCommand.destroy({ where: {} });
  await ReconcilerOwnedCommand.destroy({ where: {} });
  globalCmds.store.clear();
  globalCmds.create.mockClear();
  globalCmds.delete.mockClear();
  botReady = true;
  capabilities = ["behavior.manage"];
  systemId = await seedSystemLogin();
});

// ── helpers ─────────────────────────────────────────────────────────────────

const toMessage = {
  kind: "message",
  patternKind: "startswith",
  patternValue: "!login",
  sample: "!login",
};

const toCommand = {
  kind: "command",
  name: "login",
  description: "Get an admin login link",
  integrationTypes: ["guild_install"],
  contexts: ["BotDM"],
};

function switchTrigger(payload: Record<string, unknown>) {
  return server.inject({
    method: "PUT",
    url: "/api/behaviors/system/login/trigger",
    payload,
  });
}

async function listedSystem(): Promise<Record<string, unknown>> {
  const res = await server.inject({ method: "GET", url: "/api/behaviors" });
  return res.json().system;
}

/** The system row as stored: its trigger kind and the trigger's fields. */
async function storedLogin() {
  const row = await BehaviorDefinition.findByPk(systemId);
  const commandId = row!.getDataValue("commandId") as number | null;
  const command = commandId === null ? null : await BehaviorCommand.findByPk(commandId);
  return {
    triggerKind: row!.getDataValue("triggerKind") as string,
    patternValue: row!.getDataValue("patternValue") as string | null,
    command: command
      ? {
          name: command.getDataValue("name") as string,
          description: command.getDataValue("description") as string,
          isSystem: !!command.getDataValue("isSystem"),
        }
      : null,
  };
}

// ── message → command ───────────────────────────────────────────────────────

describe("message → command", () => {
  it("registers the command on Discord, then stores it as the login's trigger", async () => {
    const res = await switchTrigger(toCommand);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.registration).toMatchObject({
      status: "registered",
      targets: [{ target: "global", status: "created" }],
    });
    expect(body.system).toMatchObject({
      kind: "command",
      name: "login",
      isSystem: true,
      registration: "global",
      contexts: ["BotDM"],
      integrationTypes: ["guild_install"],
      section: "bot_dm",
      leaves: [{ id: systemId, systemKey: "admin-login", actionSource: "builtin", subcommand: "" }],
    });
    expect(globalCmds.names()).toEqual(["login"]);
    expect(await storedLogin()).toEqual({
      triggerKind: "command",
      patternValue: null,
      command: { name: "login", description: "Get an admin login link", isSystem: true },
    });
    expect(await listedSystem()).toMatchObject({ kind: "command", name: "login" });
  });
});

describe("message → command: a failure at any step keeps !login", () => {
  async function expectStillMessage() {
    expect(await storedLogin()).toEqual({ triggerKind: "message", patternValue: "!login", command: null });
    expect(await BehaviorCommand.count()).toBe(0);
    expect(await listedSystem()).toMatchObject({ kind: "message", patternValue: "!login" });
  }

  it("Discord refuses the registration: 502, nothing changes", async () => {
    globalCmds.create.mockRejectedValueOnce(new Error("Missing Access"));
    const res = await switchTrigger(toCommand);
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toMatchObject({
      code: "registration_failed",
      details: { targets: [{ target: "global", status: "failed", error: "Missing Access" }] },
    });
    expect(res.json().error.message).toContain("keeps its current trigger");
    expect(globalCmds.names()).toEqual([]);
    await expectStillMessage();
  });

  it("the bot is not connected: 502, nothing changes", async () => {
    botReady = false;
    const res = await switchTrigger(toCommand);
    expect(res.statusCode).toBe(502);
    expect(res.json().error.code).toBe("registration_failed");
    await expectStillMessage();
  });

  it("storing fails after Discord accepted: the command is taken back off Discord", async () => {
    const create = vi
      .spyOn(BehaviorCommand, "create")
      .mockRejectedValueOnce(new Error("SQLITE_BUSY: database is locked"));
    const res = await switchTrigger(toCommand);
    create.mockRestore();
    expect(res.statusCode).toBe(500);
    expect(globalCmds.names()).toEqual([]);
    expect(await ReconcilerOwnedCommand.count({ where: { name: "login" } })).toBe(0);
    await expectStillMessage();
  });

  it("refuses a name a plugin command holds (409, Discord untouched)", async () => {
    await PluginCommand.create({
      pluginId: 7,
      guildId: null,
      name: "login",
      featureKey: null,
      manifestJson: JSON.stringify({
        name: "login",
        description: "login",
        scope: "global",
        integration_types: ["guild_install"],
        contexts: ["Guild"],
      }),
    } as Record<string, unknown>);
    const res = await switchTrigger(toCommand);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({ code: "name_conflict", field: "name" });
    expect(globalCmds.create).not.toHaveBeenCalled();
    await expectStillMessage();
  });

  it("refuses a name a behavior command holds", async () => {
    const id = await seedCommand({ name: "admin" });
    await seedLeaf(id);
    const res = await switchTrigger({ ...toCommand, name: "admin" });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("name_conflict");
    expect(await storedLogin()).toEqual({ triggerKind: "message", patternValue: "!login", command: null });
  });
});

describe("command → message", () => {
  beforeEach(async () => {
    expect((await switchTrigger(toCommand)).statusCode).toBe(200);
  });

  it("stores the message trigger, then deletes the command from Discord", async () => {
    const res = await switchTrigger(toMessage);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      registration: { status: "removed" },
      system: {
        kind: "message",
        id: systemId,
        surface: "bot_dm",
        patternKind: "startswith",
        patternValue: "!login",
        stopOnMatch: true,
        audienceKind: "all",
        section: "bot_dm",
      },
    });
    expect(globalCmds.names()).toEqual([]);
    expect(await storedLogin()).toEqual({ triggerKind: "message", patternValue: "!login", command: null });
    expect(await BehaviorCommand.count()).toBe(0);
  });

  it("Discord refuses the deletion: the message trigger stands, reconcile removes it later", async () => {
    globalCmds.delete.mockRejectedValueOnce(new Error("Missing Access"));
    const res = await switchTrigger(toMessage);
    expect(res.statusCode).toBe(200);
    expect(res.json().registration).toMatchObject({ status: "deferred" });
    expect(await storedLogin()).toMatchObject({ triggerKind: "message", patternValue: "!login" });
    expect(globalCmds.names()).toEqual(["login"]);
    expect(botEventLog.record).toHaveBeenCalledWith(
      "warn",
      "bot",
      expect.stringContaining("could not be removed from Discord"),
      expect.anything(),
    );

    await reconciler.reconcileAll();
    expect(globalCmds.names()).toEqual([]);
  });

  it("the bot is not connected: the message trigger stands, the removal is deferred", async () => {
    botReady = false;
    const res = await switchTrigger({ ...toMessage, patternValue: "!in", sample: "!in" });
    expect(res.statusCode).toBe(200);
    expect(res.json().registration).toMatchObject({ status: "deferred" });
    expect(await storedLogin()).toMatchObject({ triggerKind: "message", patternValue: "!in" });
  });
});

describe("command → command", () => {
  beforeEach(async () => {
    expect((await switchTrigger(toCommand)).statusCode).toBe(200);
  });

  it("a rename registers the new name first, then releases /login", async () => {
    const res = await switchTrigger({ ...toCommand, name: "admin" });
    expect(res.statusCode).toBe(200);
    expect(res.json().system).toMatchObject({ kind: "command", name: "admin" });
    expect(globalCmds.names()).toEqual(["admin"]);
    expect(await storedLogin()).toMatchObject({ command: { name: "admin", isSystem: true } });
  });

  it("a rename Discord refuses keeps /login as it was", async () => {
    globalCmds.create.mockRejectedValueOnce(new Error("Missing Access"));
    const res = await switchTrigger({ ...toCommand, name: "admin" });
    expect(res.statusCode).toBe(502);
    expect(globalCmds.names()).toEqual(["login"]);
    expect(await storedLogin()).toMatchObject({ command: { name: "login" } });
  });

  it("changed settings Discord refuses keep the previous version on both sides", async () => {
    globalCmds.edit.mockRejectedValueOnce(new Error("Missing Access"));
    const res = await switchTrigger({ ...toCommand, description: "Sign in" });
    expect(res.statusCode).toBe(502);
    expect(globalCmds.byName("login")?.description).toBe("Get an admin login link");
    expect(await storedLogin()).toMatchObject({ command: { description: "Get an admin login link" } });
  });

  it("storing changed settings fails: Discord gets the stored version back", async () => {
    const save = vi
      .spyOn(BehaviorCommand.prototype, "save")
      .mockRejectedValueOnce(new Error("SQLITE_BUSY: database is locked"));
    const res = await switchTrigger({ ...toCommand, description: "Sign in" });
    save.mockRestore();
    expect(res.statusCode).toBe(500);
    expect(globalCmds.names()).toEqual(["login"]);
    expect(globalCmds.byName("login")?.description).toBe("Get an admin login link");
    expect(await storedLogin()).toMatchObject({ command: { description: "Get an admin login link" } });
  });
});

describe("message → message", () => {
  it("changes the pattern without touching Discord", async () => {
    const res = await switchTrigger({ kind: "message", patternKind: "endswith", patternValue: "please log me in", sample: "karyl, please log me in" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      registration: null,
      system: { kind: "message", patternKind: "endswith", patternValue: "please log me in" },
    });
    expect(globalCmds.create).not.toHaveBeenCalled();
  });
});

describe("reconcile after a switch", () => {
  it("a full reconcile keeps /login and does not bring back the message trigger", async () => {
    await switchTrigger(toCommand);
    await reconciler.reconcileAll();
    expect(globalCmds.names()).toEqual(["login"]);
    expect(await storedLogin()).toMatchObject({ triggerKind: "command" });
  });

  it("a full reconcile after switching back does not resurrect /login", async () => {
    await switchTrigger(toCommand);
    await switchTrigger(toMessage);
    await reconciler.reconcileAll();
    expect(globalCmds.names()).toEqual([]);
  });
});

describe("audit", () => {
  it("records the switch with both triggers and Discord's answer", async () => {
    await switchTrigger(toCommand);
    const entries = await listAudit({ limit: 5 });
    const entry = entries.find((e) => e.action === "behavior.system.trigger");
    expect(entry).toMatchObject({
      target: `behavior:${systemId}`,
      context: {
        from: { kind: "message", patternKind: "startswith", patternValue: "!login" },
        to: { kind: "command", name: "login", contexts: ["BotDM"], integrationTypes: ["guild_install"] },
        outcome: "switched",
        registration: "registered",
      },
    });
  });

  async function lastSwitchAudit() {
    const entries = await listAudit({ limit: 20 });
    return entries.find((e) => e.action === "behavior.system.trigger");
  }

  it("records a registration Discord refused", async () => {
    globalCmds.create.mockRejectedValueOnce(new Error("Missing Access"));
    expect((await switchTrigger(toCommand)).statusCode).toBe(502);
    expect(await lastSwitchAudit()).toMatchObject({
      target: `behavior:${systemId}`,
      context: {
        from: { kind: "message", patternValue: "!login" },
        to: { kind: "command", name: "login" },
        outcome: "registration_failed",
        error: expect.stringContaining("Missing Access"),
      },
    });
  });

  it("records a name conflict", async () => {
    const id = await seedCommand({ name: "admin" });
    await seedLeaf(id);
    expect((await switchTrigger({ ...toCommand, name: "admin" })).statusCode).toBe(409);
    expect(await lastSwitchAudit()).toMatchObject({
      context: { to: { name: "admin" }, outcome: "name_conflict" },
    });
  });

  it("records a failed store and whether Discord was put back", async () => {
    const create = vi
      .spyOn(BehaviorCommand, "create")
      .mockRejectedValueOnce(new Error("SQLITE_BUSY: database is locked"));
    expect((await switchTrigger(toCommand)).statusCode).toBe(500);
    create.mockRestore();
    expect(await lastSwitchAudit()).toMatchObject({
      context: { outcome: "store_failed", registrationTakenBack: true },
    });

    const again = vi
      .spyOn(BehaviorCommand, "create")
      .mockRejectedValueOnce(new Error("SQLITE_BUSY: database is locked"));
    globalCmds.delete.mockRejectedValueOnce(new Error("Missing Access"));
    expect((await switchTrigger(toCommand)).statusCode).toBe(500);
    again.mockRestore();
    expect(await lastSwitchAudit()).toMatchObject({
      context: { outcome: "store_failed", registrationTakenBack: false },
    });
  });

  it("does not record a request refused before the switch", async () => {
    const before = (await lastSwitchAudit())?.id ?? 0;
    expect((await switchTrigger({ ...toMessage, sample: "hello" })).statusCode).toBe(400);
    expect((await lastSwitchAudit())?.id ?? 0).toBe(before);
  });
});

describe("refusals", () => {
  const msg = (extra: Record<string, unknown>) => ({
    kind: "message",
    patternKind: "startswith",
    patternValue: "!x",
    sample: "!x",
    ...extra,
  });
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ["an unknown kind", { kind: "slash" }, "kind"],
    ["a missing kind", { patternValue: "!x" }, "kind"],
    ["a guild registration", { ...toCommand, registration: "guild" }, "registration"],
    ["default member permissions", { ...toCommand, defaultMemberPermissions: "8" }, "defaultMemberPermissions"],
    ["a guild surface", msg({ surface: "guild" }), "surface"],
    ["an audience", msg({ audienceKind: "user" }), "audienceKind"],
    ["a pattern on a command", { ...toCommand, patternValue: "!x" }, "patternValue"],
    ["a name on a message", msg({ name: "x" }), "name"],
    ["a message without a pattern", { kind: "message", patternKind: "startswith" }, "patternValue"],
    ["a message without a pattern kind", { kind: "message", patternValue: "!x" }, "patternKind"],
    ["a command without a name", { kind: "command", description: "x" }, "name"],
    ["a command without a description", { kind: "command", name: "login" }, "description"],
    ["a blank pattern", msg({ patternValue: "   " }), "patternValue"],
    ["a pattern with edge spaces", msg({ patternValue: " !login" }), "patternValue"],
    ["a regex", msg({ patternKind: "regex", patternValue: "^!login$", sample: "!login" }), "patternKind"],
    ["a regex that never matches", msg({ patternKind: "regex", patternValue: "(?!)" }), "patternKind"],
    ["a message without a sample", { kind: "message", patternKind: "startswith", patternValue: "!x" }, "sample"],
    ["a blank sample", msg({ sample: "   " }), "sample"],
    ["a sample the pattern does not match (case)", msg({ patternValue: "!login", sample: "!Login" }), "sample"],
    ["a sample the pattern does not match (a mention arrives as <@id>)", msg({ patternValue: "@karyl login", sample: "<@123456789012345678> login" }), "sample"],
    ["a sample on a command", { ...toCommand, sample: "!x" }, "sample"],
    ["a command installed by users only", { ...toCommand, integrationTypes: ["user_install"] }, "integrationTypes"],
    ["a command usable in guilds only", { ...toCommand, contexts: ["Guild"] }, "contexts"],
    ["a command usable in other DMs only", { ...toCommand, integrationTypes: ["guild_install", "user_install"], contexts: ["PrivateChannel"] }, "contexts"],
    ["an invalid command name", { ...toCommand, name: "Log In" }, "name"],
    ["other DMs without user install", { ...toCommand, contexts: ["BotDM", "PrivateChannel"] }, "contexts"],
    ["an empty context list", { ...toCommand, contexts: [] }, "contexts"],
  ];

  it.each(cases)("refuses %s (400)", async (_what, payload, field) => {
    const res = await switchTrigger(payload);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatchObject({ code: "validation_failed", field });
    expect(await storedLogin()).toMatchObject({ triggerKind: "message", patternValue: "!login" });
    expect(globalCmds.create).not.toHaveBeenCalled();
  });

  it("accepts a sample the pattern matches, as Discord delivers it (trimmed)", async () => {
    const res = await switchTrigger({ ...toMessage, patternValue: "!admin", sample: "  !admin please  " });
    expect(res.statusCode).toBe(200);
    expect(await storedLogin()).toMatchObject({ triggerKind: "message", patternValue: "!admin" });
  });

  it("accepts a command reachable from bot DMs with more contexts and installs", async () => {
    const res = await switchTrigger({
      ...toCommand,
      integrationTypes: ["guild_install", "user_install"],
      contexts: ["BotDM", "Guild", "PrivateChannel"],
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().system).toMatchObject({ section: "app" });
  });

  it("refuses an edit based on an outdated view (409)", async () => {
    const res = await switchTrigger({ ...toCommand, ifUpdatedAt: "2000-01-01T00:00:00.000Z" });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({ code: "validation_failed", field: "ifUpdatedAt" });
    expect(globalCmds.create).not.toHaveBeenCalled();
  });

  it("accepts an edit based on the current view", async () => {
    const view = await listedSystem();
    const res = await switchTrigger({ ...toCommand, ifUpdatedAt: view.updatedAt });
    expect(res.statusCode).toBe(200);
  });

  it("refuses a caller without behavior.manage (403)", async () => {
    capabilities = ["system.read"];
    const res = await switchTrigger(toCommand);
    expect(res.statusCode).toBe(403);
  });

  it("answers not_found when there is no system login (404)", async () => {
    await clearBehaviors();
    const res = await switchTrigger(toCommand);
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("not_found");
    expect(globalCmds.create).not.toHaveBeenCalled();
  });
});

describe("the rest of the system row stays immutable", () => {
  it("its message trigger cannot be edited, disabled or deleted elsewhere", async () => {
    for (const res of [
      await server.inject({ method: "PATCH", url: `/api/behaviors/${systemId}`, payload: { patternValue: "!x" } }),
      await server.inject({ method: "PATCH", url: `/api/behaviors/${systemId}`, payload: { enabled: false } }),
      await server.inject({ method: "PATCH", url: `/api/behaviors/${systemId}`, payload: { title: "x" } }),
      await server.inject({ method: "DELETE", url: `/api/behaviors/${systemId}` }),
    ]) {
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe("system_immutable");
    }
  });

  it("its command cannot be edited, extended or deleted elsewhere, but can be resynced", async () => {
    const commandId = (await switchTrigger(toCommand)).json().system.id as number;
    for (const res of [
      await server.inject({ method: "PATCH", url: `/api/behavior-commands/${commandId}`, payload: { name: "x" } }),
      await server.inject({ method: "DELETE", url: `/api/behavior-commands/${commandId}` }),
      await server.inject({ method: "PATCH", url: `/api/behaviors/${systemId}`, payload: { enabled: false } }),
      await server.inject({
        method: "POST",
        url: `/api/behavior-commands/${commandId}/leaves`,
        payload: { subcommand: "x", title: "x", webhook: { url: "https://203.0.113.10/hook" } },
      }),
    ]) {
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe("system_immutable");
    }

    // Discord lost it: a resync registers it again
    globalCmds.store.clear();
    const res = await server.inject({ method: "POST", url: `/api/behavior-commands/${commandId}/resync` });
    expect(res.statusCode).toBe(200);
    expect(res.json().registration).toMatchObject({ status: "registered" });
    expect(globalCmds.names()).toEqual(["login"]);
  });
});

describe("more failures: the old trigger always holds", () => {
  it("a rename whose store fails takes the new name back off Discord, /login stays", async () => {
    expect((await switchTrigger(toCommand)).statusCode).toBe(200);
    const save = vi
      .spyOn(BehaviorCommand.prototype, "save")
      .mockRejectedValueOnce(new Error("SQLITE_BUSY: database is locked"));
    const res = await switchTrigger({ ...toCommand, name: "admin" });
    save.mockRestore();
    expect(res.statusCode).toBe(500);
    expect(globalCmds.names()).toEqual(["login"]);
    expect(await storedLogin()).toMatchObject({ triggerKind: "command", command: { name: "login" } });
  });

  it("a rename whose old name Discord will not delete still switches; reconcile removes it", async () => {
    expect((await switchTrigger(toCommand)).statusCode).toBe(200);
    globalCmds.delete.mockRejectedValueOnce(new Error("Missing Access"));
    const res = await switchTrigger({ ...toCommand, name: "admin" });
    expect(res.statusCode).toBe(200);
    expect(globalCmds.names()).toEqual(["admin", "login"]);
    expect(botEventLog.record).toHaveBeenCalledWith(
      "warn",
      "bot",
      expect.stringContaining("the old /login could not be removed"),
      expect.anything(),
    );
    await reconciler.reconcileAll();
    expect(globalCmds.names()).toEqual(["admin"]);
  });

  it("command → message whose store fails keeps /login working", async () => {
    expect((await switchTrigger(toCommand)).statusCode).toBe(200);
    const save = vi
      .spyOn(BehaviorDefinition.prototype, "save")
      .mockRejectedValueOnce(new Error("SQLITE_BUSY: database is locked"));
    const res = await switchTrigger(toMessage);
    save.mockRestore();
    expect(res.statusCode).toBe(500);
    expect(globalCmds.names()).toEqual(["login"]);
    expect(await storedLogin()).toMatchObject({ triggerKind: "command", command: { name: "login" } });
    expect(globalCmds.delete).not.toHaveBeenCalled();
  });

  it("a store that fails and a take-back Discord refuses: logged, !login holds, reconcile cleans up", async () => {
    const create = vi
      .spyOn(BehaviorCommand, "create")
      .mockRejectedValueOnce(new Error("SQLITE_BUSY: database is locked"));
    globalCmds.delete.mockRejectedValueOnce(new Error("Missing Access"));
    const res = await switchTrigger(toCommand);
    create.mockRestore();
    expect(res.statusCode).toBe(500);
    expect(await storedLogin()).toEqual({ triggerKind: "message", patternValue: "!login", command: null });
    expect(botEventLog.record).toHaveBeenCalledWith(
      "error",
      "bot",
      expect.stringContaining("could not be taken back"),
      expect.anything(),
    );
    // an orphan /login on Discord, owned by the roster: the next full reconcile removes it
    expect(globalCmds.names()).toEqual(["login"]);
    await reconciler.reconcileAll();
    expect(globalCmds.names()).toEqual([]);
  });
});

describe("serialised with reconciles", () => {
  it("a full reconcile started mid-switch runs after it and keeps the new command", async () => {
    let sweep: Promise<unknown> | null = null;
    const create = globalCmds.create.getMockImplementation()!;
    globalCmds.create.mockImplementationOnce(async (data: CmdStub) => {
      // Discord just accepted /login; nothing is stored yet
      sweep = reconciler.reconcileAll();
      return create(data);
    });
    expect((await switchTrigger(toCommand)).statusCode).toBe(200);
    await sweep;
    expect(globalCmds.names()).toEqual(["login"]);
  });
});

describe("owner only", () => {
  /** The same routes, called by an admin who is not a bot owner. */
  async function asNonOwnerAdmin(): Promise<FastifyInstance> {
    const other = Fastify({ logger: false });
    other.addHook("onRequest", async (request) => {
      request.authUserId = "222222222222222222";
      request.authCapabilities = new Set(["admin"]) as never;
    });
    await registerBehaviorRoutes(other, {
      reconciler,
      namespace: new CommandNamespace(),
      ownerIds: [OWNER],
    });
    await other.ready();
    return other;
  }

  it("an admin who is not the owner cannot switch the login's trigger (403)", async () => {
    const other = await asNonOwnerAdmin();
    try {
      for (const payload of [toCommand, toMessage, { kind: "slash" }]) {
        const res = await other.inject({
          method: "PUT",
          url: "/api/behaviors/system/login/trigger",
          payload,
        });
        expect(res.statusCode).toBe(403);
      }
      expect(globalCmds.create).not.toHaveBeenCalled();
      expect(await storedLogin()).toMatchObject({ triggerKind: "message", patternValue: "!login" });
    } finally {
      await other.close();
    }
  });

  it("an admin who is not the owner cannot resync the login's command, but can resync others", async () => {
    const commandId = (await switchTrigger(toCommand)).json().system.id as number;
    const otherCommand = await seedCommand({ name: "ping" });
    await seedLeaf(otherCommand);
    const other = await asNonOwnerAdmin();
    try {
      const login = await other.inject({ method: "POST", url: `/api/behavior-commands/${commandId}/resync` });
      expect(login.statusCode).toBe(403);
      const ping = await other.inject({ method: "POST", url: `/api/behavior-commands/${otherCommand}/resync` });
      expect(ping.statusCode).toBe(200);
    } finally {
      await other.close();
    }
  });
});

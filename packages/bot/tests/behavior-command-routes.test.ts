/**
 * #136 — /api/behavior-commands: a Command (name + visibility) and its
 * Command Leaves are written, checked against Discord's rules and the
 * shared command namespace (#96), and registered with Discord through the
 * reconciler before the write counts. A registration Discord refuses
 * restores the previous rows (registration_failed); a bot that is not
 * connected yet defers registration to the boot reconcile.
 *
 * Discord is a stateful fake behind a real CommandReconciler; the
 * namespace is the real CommandNamespace over the same SQLite.
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
import { listAudit } from "../src/modules/admin/admin-audit.service.js";
import { PluginCommand } from "../src/modules/plugin-system/models/plugin-command.model.js";
import { ReconcilerOwnedCommand } from "../src/modules/command-system/models/reconciler-owned-command.model.js";
import { CommandReconciler } from "../src/modules/command-system/reconcile.service.js";
import { CommandNamespace } from "../src/modules/command-system/command-namespace.js";
import { clearBehaviors, seedCommand, seedLeaf } from "./behavior-fixtures.js";

const HOOK = "https://203.0.113.10/hook";
const GUILD = "123456789012345678";
const OTHER_GUILD = "223456789012345678";

// ── fake Discord ────────────────────────────────────────────────────────────

interface CmdStub {
  id: string;
  name: string;
  description: string;
  options?: unknown[];
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
  let refuse: string | null = null;
  return {
    store,
    names: () => [...store.values()].map((c) => c.name).sort(),
    byName: (name: string) => [...store.values()].find((c) => c.name === name),
    refuseNext(message: string) {
      refuse = message;
    },
    fetch: vi.fn(async () => new FakeCollection(store)),
    create: vi.fn(async (data: CmdStub) => {
      if (refuse) {
        const m = refuse;
        refuse = null;
        throw new Error(m);
      }
      const cmd = { ...data, id: `c${++idc}` };
      store.set(cmd.id, cmd);
      return cmd;
    }),
    edit: vi.fn(async (id: string, data: CmdStub) => {
      if (refuse) {
        const m = refuse;
        refuse = null;
        throw new Error(m);
      }
      store.set(id, { ...data, id });
      return store.get(id);
    }),
    delete: vi.fn(async (id: string) => {
      store.delete(id);
    }),
  };
}

const globalCmds = fakeCommands();
const guildCmds = fakeCommands();
let botReady = true;
const reconciler = new CommandReconciler(() =>
  botReady
    ? ({
        application: { commands: globalCmds },
        guilds: { cache: new Map([[GUILD, { id: GUILD, commands: guildCmds }]]) },
      } as unknown as Client)
    : null,
);

let server: FastifyInstance;

beforeAll(async () => {
  await sequelize.sync({ force: true });
  server = Fastify({ logger: false });
  server.addHook("onRequest", async (request) => {
    request.authUserId = "admin";
    request.authCapabilities = new Set(["behavior.manage"]) as never;
  });
  await registerBehaviorRoutes(server, {
    reconciler,
    namespace: new CommandNamespace(),
  });
  await server.ready();
});

beforeEach(async () => {
  await clearBehaviors();
  await PluginCommand.destroy({ where: {} });
  await ReconcilerOwnedCommand.destroy({ where: {} });
  globalCmds.store.clear();
  guildCmds.store.clear();
  botReady = true;
});

// ── helpers ─────────────────────────────────────────────────────────────────

const rootLeaf = { title: "Ping", webhook: { url: HOOK } };

const guildCommand = {
  name: "nas",
  description: "NAS tools",
  registration: "guild",
  guildId: GUILD,
  leaves: [rootLeaf],
};

function create(payload: Record<string, unknown>) {
  return server.inject({ method: "POST", url: "/api/behavior-commands", payload });
}

function patchCommand(id: number, payload: Record<string, unknown>) {
  return server.inject({ method: "PATCH", url: `/api/behavior-commands/${id}`, payload });
}

async function listedCommands(): Promise<Array<Record<string, unknown>>> {
  const res = await server.inject({ method: "GET", url: "/api/behaviors" });
  return res.json().commands;
}

async function seedPluginCommand(name: string, scope: "global" | "guild" = "global") {
  await PluginCommand.create({
    pluginId: 7,
    guildId: null,
    name,
    featureKey: null,
    manifestJson: JSON.stringify({
      name,
      description: name,
      scope,
      integration_types: ["guild_install"],
      contexts: ["Guild"],
    }),
  } as Record<string, unknown>);
}

// ── create ──────────────────────────────────────────────────────────────────

describe("POST /api/behavior-commands", () => {
  it("creates a guild command and registers it in that guild", async () => {
    const res = await create(guildCommand);
    expect(res.statusCode).toBe(201);
    const { command, registration } = res.json();
    expect(command).toMatchObject({
      kind: "command",
      name: "nas",
      description: "NAS tools",
      registration: "guild",
      guildId: GUILD,
      contexts: ["Guild"],
      integrationTypes: ["guild_install"],
      section: `guild:${GUILD}`,
      leaves: [{ subcommand: "", title: "Ping", enabled: true, options: [] }],
    });
    expect(registration).toMatchObject({ status: "registered" });
    expect(guildCmds.names()).toEqual(["nas"]);
    expect(globalCmds.names()).toEqual([]);
  });

  it("creates a global app command with subcommands", async () => {
    const res = await create({
      name: "tools",
      description: "Tools",
      registration: "global",
      integrationTypes: ["guild_install", "user_install"],
      contexts: ["Guild", "BotDM", "PrivateChannel"],
      leaves: [
        { subcommand: "wake", title: "Wake", leafDescription: "Wake a host", webhook: { url: HOOK } },
        {
          subcommand: "status",
          title: "Status",
          options: [{ type: "string", name: "host", description: "Host name", required: true }],
          webhook: { url: HOOK, authMode: "hmac" },
        },
      ],
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.command.section).toBe("app");
    expect(body.secrets).toEqual([
      { behaviorId: expect.any(Number), subcommand: "status", secret: expect.stringMatching(/^[0-9a-f]{64}$/) },
    ]);
    const registered = globalCmds.byName("tools")!;
    expect((registered.options as Array<{ name: string; description: string }>).map((o) => [o.name, o.description]))
      .toEqual([
        ["wake", "Wake a host"],
        ["status", "Status"],
      ]);
  });

  it("saves and defers registration while the bot is not connected", async () => {
    botReady = false;
    const res = await create(guildCommand);
    expect(res.statusCode).toBe(201);
    expect(res.json().registration).toMatchObject({ status: "deferred" });
    expect(await listedCommands()).toHaveLength(1);
  });

  it("saves nothing when Discord refuses the command", async () => {
    const lastAudit = (await listAudit({ limit: 1 }))[0]?.id;
    guildCmds.refuseNext("Invalid Form Body");
    const res = await create(guildCommand);
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toMatchObject({
      code: "registration_failed",
      message: expect.stringContaining("Invalid Form Body"),
    });
    expect(await listedCommands()).toEqual([]);
    expect((await listAudit({ limit: 1 }))[0]?.id).toBe(lastAudit);
  });

  it("registration fails for a guild the bot is not in", async () => {
    const res = await create({ ...guildCommand, guildId: OTHER_GUILD });
    expect(res.statusCode).toBe(502);
    expect(res.json().error.code).toBe("registration_failed");
    expect(await listedCommands()).toEqual([]);
  });

  it.each([
    ["an invalid name", { name: "Bad Name" }, "name"],
    ["a description over 100 chars", { description: "x".repeat(101) }, "description"],
    ["a blank description", { description: "  " }, "description"],
    ["a guild command usable in bot DMs", { contexts: ["Guild", "BotDM"] }, "contexts"],
    ["a guild command installable by users", { integrationTypes: ["user_install"] }, "integrationTypes"],
    ["a guild command without its guild", { guildId: null }, "guildId"],
    ["a global command with a guild", { registration: "global" }, "guildId"],
    ["a non-snowflake guild", { guildId: "42" }, "guildId"],
    ["no leaves", { leaves: [] }, "leaves"],
    ["an unknown field", { scope: "guild" }, "scope"],
    ["a required option after an optional one", {
      leaves: [{ ...rootLeaf, options: [
        { type: "string", name: "a", description: "a", required: false },
        { type: "string", name: "b", description: "b", required: true },
      ] }],
    }, "leaves.0.options.1.required"],
    ["a duplicated option name", {
      leaves: [{ ...rootLeaf, options: [
        { type: "string", name: "a", description: "a" },
        { type: "integer", name: "a", description: "b" },
      ] }],
    }, "leaves.0.options.1.name"],
    ["more than 25 subcommands", {
      leaves: Array.from({ length: 26 }, (_, i) => ({ ...rootLeaf, subcommand: `s${i}` })),
    }, "leaves"],
    ["more than 8000 characters in total", {
      leaves: Array.from({ length: 25 }, (_, i) => ({
        ...rootLeaf,
        subcommand: `s${i}`,
        leafDescription: "d".repeat(100),
        options: Array.from({ length: 4 }, (_, j) => ({ type: "string", name: `o${j}`, description: "o".repeat(100) })),
      })),
    }, "leaves"],
    ["a plain-http public webhook", { leaves: [{ ...rootLeaf, webhook: { url: "http://203.0.113.10/x" } }] }, "leaves.0.webhook.url"],
  ])("refuses %s", async (_what, change, field) => {
    const res = await create({ ...guildCommand, ...change });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatchObject({ code: "validation_failed", field });
    expect(await listedCommands()).toEqual([]);
  });

  it("refuses a root leaf next to subcommands (invalid_tree)", async () => {
    const res = await create({
      ...guildCommand,
      leaves: [rootLeaf, { ...rootLeaf, subcommand: "wake" }],
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({ code: "invalid_tree", field: "leaves" });
  });

  it("refuses two leaves on one path (invalid_tree)", async () => {
    const res = await create({
      ...guildCommand,
      leaves: [{ ...rootLeaf, subcommand: "a" }, { ...rootLeaf, subcommand: "a" }],
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({ code: "invalid_tree", field: "leaves.1.subcommand" });
  });
});

// ── name conflicts (#96) ────────────────────────────────────────────────────

describe("name conflicts", () => {
  it("a track-3 plugin command holds its name everywhere it can appear", async () => {
    await seedPluginCommand("nas", "guild"); // registered in every guild
    const res = await create(guildCommand);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({
      code: "name_conflict",
      field: "name",
      message: expect.stringContaining("plugin"),
    });
    expect(guildCmds.names()).toEqual([]);
  });

  it("a global plugin command conflicts with a guild command of the same name", async () => {
    await seedPluginCommand("nas", "global");
    expect((await create(guildCommand)).statusCode).toBe(409);
  });

  it("two behavior commands may share a name in different guilds only", async () => {
    expect((await create(guildCommand)).statusCode).toBe(201);
    expect((await create({ ...guildCommand, guildId: OTHER_GUILD })).statusCode).not.toBe(409);
    const same = await create(guildCommand);
    expect(same.statusCode).toBe(409);
    expect(same.json().error.code).toBe("name_conflict");
    const global = await create({ ...guildCommand, registration: "global", guildId: null });
    expect(global.statusCode).toBe(409);
  });

  it("`login` stays reserved for the system login", async () => {
    const res = await create({ ...guildCommand, name: "login" });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({ code: "name_conflict", field: "name" });
  });

  it("renaming onto a taken name is refused", async () => {
    await seedPluginCommand("taken");
    const id = (await create(guildCommand)).json().command.id;
    const res = await patchCommand(id, { name: "taken" });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("name_conflict");
  });
});

// ── update / delete / resync ────────────────────────────────────────────────

describe("PATCH /api/behavior-commands/:id", () => {
  it("renames the command on Discord and drops the old name", async () => {
    const id = (await create(guildCommand)).json().command.id;
    const res = await patchCommand(id, { name: "storage", description: "Storage" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      command: { name: "storage", description: "Storage" },
      registration: { status: "registered" },
    });
    expect(guildCmds.names()).toEqual(["storage"]);
  });

  it("moves a guild command to global", async () => {
    const id = (await create(guildCommand)).json().command.id;
    const res = await patchCommand(id, { registration: "global", guildId: null });
    expect(res.statusCode).toBe(200);
    expect(res.json().command.section).toBe("guild:all");
    expect(globalCmds.names()).toEqual(["nas"]);
    expect(guildCmds.names()).toEqual([]);
  });

  it("restores the previous command when Discord refuses the edit", async () => {
    const id = (await create(guildCommand)).json().command.id;
    guildCmds.refuseNext("Missing Access");
    const res = await patchCommand(id, { description: "Renamed tools" });
    expect(res.statusCode).toBe(502);
    expect(res.json().error.code).toBe("registration_failed");
    const [command] = await listedCommands();
    expect(command).toMatchObject({ description: "NAS tools" });
    expect(guildCmds.byName("nas")!.description).toBe("NAS tools");
  });

  it("checks the merged settings", async () => {
    const id = (await create(guildCommand)).json().command.id;
    const res = await patchCommand(id, { contexts: ["BotDM"] });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatchObject({ code: "validation_failed", field: "contexts" });
  });

  it("refuses a stale write", async () => {
    const id = (await create(guildCommand)).json().command.id;
    const res = await patchCommand(id, { description: "x", ifUpdatedAt: "2000-01-01T00:00:00.000Z" });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({ code: "validation_failed", field: "ifUpdatedAt" });
  });

  it("an unknown command is not_found", async () => {
    const res = await patchCommand(9999, { description: "x" });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("not_found");
  });

  it("the system command is immutable", async () => {
    const id = await seedCommand({ name: "login", isSystem: true });
    await seedLeaf(id, { systemKey: "admin-login", actionSource: "builtin" }, null);
    const res = await patchCommand(id, { description: "x" });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("system_immutable");
    const del = await server.inject({ method: "DELETE", url: `/api/behavior-commands/${id}` });
    expect(del.statusCode).toBe(409);
    expect(del.json().error.code).toBe("system_immutable");
  });
});

describe("DELETE /api/behavior-commands/:id", () => {
  it("deletes the command and its Discord registration", async () => {
    const id = (await create(guildCommand)).json().command.id;
    const res = await server.inject({ method: "DELETE", url: `/api/behavior-commands/${id}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().registration).toMatchObject({ status: "removed" });
    expect(guildCmds.names()).toEqual([]);
    expect(await listedCommands()).toEqual([]);
  });
});

describe("POST /api/behavior-commands/:id/resync", () => {
  it("registers the command again", async () => {
    const id = (await create(guildCommand)).json().command.id;
    guildCmds.store.clear(); // someone removed it on Discord
    const res = await server.inject({ method: "POST", url: `/api/behavior-commands/${id}/resync` });
    expect(res.statusCode).toBe(200);
    expect(res.json().registration).toMatchObject({ status: "registered" });
    expect(guildCmds.names()).toEqual(["nas"]);
  });

  it("reports a refused registration", async () => {
    const id = (await create(guildCommand)).json().command.id;
    guildCmds.store.clear();
    guildCmds.refuseNext("rate limited");
    const res = await server.inject({ method: "POST", url: `/api/behavior-commands/${id}/resync` });
    expect(res.statusCode).toBe(502);
    expect(res.json().error.code).toBe("registration_failed");
  });
});

describe("audit", () => {
  it("records command writes with their registration outcome", async () => {
    const created = (await create({
      ...guildCommand,
      leaves: [{ ...rootLeaf, webhook: { url: HOOK, authMode: "token" } }],
    })).json();
    await patchCommand(created.command.id, { description: "More tools" });
    await server.inject({ method: "DELETE", url: `/api/behavior-commands/${created.command.id}` });

    const entries = (await listAudit({ limit: 3 })).reverse();
    expect(entries.map((e) => [e.action, e.target])).toEqual([
      ["behavior.command.create", `command:${created.command.id}`],
      ["behavior.command.update", `command:${created.command.id}`],
      ["behavior.command.delete", `command:${created.command.id}`],
    ]);
    expect(entries[0]!.context).toMatchObject({
      name: "nas",
      registration: "registered",
      leaves: [{ subcommand: "", webhook: { authMode: "token", secretSet: true } }],
    });
    expect(entries[1]!.context).toMatchObject({
      changed: { description: { from: "NAS tools", to: "More tools" } },
    });
    const text = JSON.stringify(entries);
    expect(text).not.toContain(created.secrets[0].secret);
    expect(text).not.toContain("203.0.113.10");
  });
});

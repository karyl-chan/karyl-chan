/**
 * #172 — POST /api/behaviors/:id/convert-trigger: a custom behavior
 * moves between a Message Trigger and a Command Leaf and stays the same
 * behavior — id, title, note, enabled flag, webhook (URL, secret, the
 * rotating previous secret), statistics and delivery log.
 *
 *   - to a command: registered on Discord first, stored only after; a
 *     refusal leaves the message trigger as it was
 *   - to a message: stored first, then the command left behind is
 *     re-registered or removed
 *
 * Discord is a stateful fake behind a real CommandReconciler; the
 * namespace is the real CommandNamespace over the same database.
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
import type { QueryInterface } from "sequelize";
import { sequelize } from "../src/db.js";
import { syncBehaviorRouteTables } from "./behavior-route-tables.js";
import { up as indexes011 } from "../src/migrations/011-behavior-trigger-action-tables.js";
import { registerBehaviorRoutes } from "../src/modules/behavior/behavior-routes.js";
import { listAudit } from "../src/modules/admin/admin-audit.service.js";
import { BehaviorCommand } from "../src/modules/behavior/models/behavior-command.model.js";
import { BehaviorDefinition } from "../src/modules/behavior/models/behavior-definition.model.js";
import { BehaviorDelivery } from "../src/modules/behavior/models/behavior-delivery.model.js";
import { BehaviorGroupMember } from "../src/modules/behavior/models/behavior-group-member.model.js";
import { BehaviorStat } from "../src/modules/behavior/models/behavior-stats.model.js";
import { BehaviorWebhookAction } from "../src/modules/behavior/models/behavior-webhook-action.model.js";
import { PluginCommand } from "../src/modules/plugin-system/models/plugin-command.model.js";
import { ReconcilerOwnedCommand } from "../src/modules/command-system/models/reconciler-owned-command.model.js";
import { CommandReconciler } from "../src/modules/command-system/reconcile.service.js";
import { CommandNamespace } from "../src/modules/command-system/command-namespace.js";
import { encryptSecret } from "../src/utils/crypto.js";
import {
  clearBehaviors,
  seedCommand,
  seedLeaf,
  seedMessageTrigger,
  seedSystemLogin,
} from "./behavior-fixtures.js";

// ── fake Discord ────────────────────────────────────────────────────────────

interface CmdStub {
  id: string;
  name: string;
  description: string;
  options?: Array<{ name: string }>;
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

beforeAll(async () => {
  await syncBehaviorRouteTables();
  await (indexes011 as (c: { context: QueryInterface }) => Promise<void>)({
    context: sequelize.getQueryInterface(),
  });
  server = Fastify({ logger: false });
  server.addHook("onRequest", async (request) => {
    request.authUserId = "admin";
    request.authCapabilities = new Set(["behavior.manage"]) as never;
  });
  await registerBehaviorRoutes(server, { reconciler, namespace: new CommandNamespace() });
  await server.ready();
});

beforeEach(async () => {
  await BehaviorDelivery.destroy({ where: {} });
  await BehaviorStat.destroy({ where: {} });
  await clearBehaviors();
  await PluginCommand.destroy({ where: {} });
  await ReconcilerOwnedCommand.destroy({ where: {} });
  globalCmds.store.clear();
  globalCmds.create.mockClear();
  globalCmds.edit.mockClear();
  globalCmds.delete.mockClear();
  botReady = true;
});

// ── helpers ─────────────────────────────────────────────────────────────────

const GRACE = new Date(Date.now() + 3600_000);

/** A guild message trigger with a secret mid-rotation, statistics and a delivery. */
async function seedConvertible(overrides: Record<string, unknown> = {}): Promise<number> {
  const id = await seedMessageTrigger(
    {
      title: "Weather",
      description: "admin note",
      surface: "guild",
      patternValue: "!weather",
      stopOnMatch: true,
      ...overrides,
    },
    {
      authMode: "hmac",
      secret: encryptSecret("s3cret"),
      previousSecret: encryptSecret("old"),
      previousSecretExpiresAt: GRACE,
    },
  );
  await BehaviorStat.create({ behaviorId: id, successCount: 4, failureCount: 1 });
  await BehaviorDelivery.create({ behaviorId: id, firedAt: new Date(), via: "message", ok: true });
  return id;
}

async function updatedAtOf(id: number): Promise<string> {
  const row = await BehaviorDefinition.findByPk(id);
  return (row!.getDataValue("updatedAt") as Date).toISOString();
}

async function convert(id: number, payload: Record<string, unknown>) {
  return server.inject({
    method: "POST",
    url: `/api/behaviors/${id}/convert-trigger`,
    payload: { ifUpdatedAt: await updatedAtOf(id), ...payload },
  });
}

/** What a conversion must never change: the webhook row, the stats and the deliveries. */
async function keptState(id: number) {
  const action = await BehaviorWebhookAction.findByPk(id);
  const stat = await BehaviorStat.findByPk(id);
  const row = await BehaviorDefinition.findByPk(id);
  return {
    title: row!.getDataValue("title"),
    description: row!.getDataValue("description"),
    enabled: !!row!.getDataValue("enabled"),
    webhook: {
      url: action!.getDataValue("url"),
      secret: action!.getDataValue("secret"),
      previousSecret: action!.getDataValue("previousSecret"),
      authMode: action!.getDataValue("authMode"),
    },
    successCount: stat!.getDataValue("successCount"),
    deliveries: await BehaviorDelivery.count({ where: { behaviorId: id } }),
  };
}

const newCommand = {
  name: "weather",
  registration: "global",
  integrationTypes: ["guild_install"],
  contexts: ["Guild"],
};

const toGuildMessage = {
  to: "message",
  location: "guild:all",
  patternKind: "startswith",
  patternValue: "!weather",
};

// ── message → command ───────────────────────────────────────────────────────

describe("message → a new command", () => {
  it("registers the command, then makes the behavior its root leaf — the same behavior", async () => {
    const id = await seedConvertible();
    const before = await keptState(id);
    const res = await convert(id, { to: "command", command: { new: newCommand } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.registration).toMatchObject({
      status: "registered",
      targets: [{ target: "global", status: "created" }],
    });
    expect(body.command).toMatchObject({
      kind: "command",
      name: "weather",
      // the description defaults to the title
      description: "Weather",
      section: "guild:all",
      leaves: [{ id, subcommand: "", title: "Weather", options: [] }],
    });
    expect(body.behavior).toMatchObject({ id, title: "Weather", description: "admin note", enabled: true });
    expect(body.behavior.webhook).toMatchObject({ secretSet: true, authMode: "hmac" });
    expect(body.behavior.webhook.previousSecretExpiresAt).not.toBeNull();
    expect(body.behavior.stats).toMatchObject({ successCount: 4, failureCount: 1 });
    expect(globalCmds.byName("weather")).toMatchObject({ description: "Weather" });

    expect(await keptState(id)).toEqual(before);
    const row = await BehaviorDefinition.findByPk(id);
    expect(row!.get({ plain: true })).toMatchObject({
      triggerKind: "command",
      surface: null,
      patternKind: null,
      patternValue: null,
      stopOnMatch: false,
    });
  });

  it("Discord refuses: 502, the message trigger stays exactly as it was", async () => {
    const id = await seedConvertible();
    const stamp = await updatedAtOf(id);
    globalCmds.create.mockRejectedValueOnce(new Error("Missing Access"));
    const res = await convert(id, { to: "command", command: { new: newCommand } });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toMatchObject({
      code: "registration_failed",
      details: { targets: [{ target: "global", status: "failed", error: "Missing Access" }] },
    });
    expect(res.json().error.message).toContain("keeps its message trigger");
    const row = await BehaviorDefinition.findByPk(id);
    expect(row!.get({ plain: true })).toMatchObject({
      triggerKind: "message",
      patternValue: "!weather",
      stopOnMatch: true,
      commandId: null,
    });
    expect(await updatedAtOf(id)).toBe(stamp);
    expect(await BehaviorCommand.count()).toBe(0);
    expect(globalCmds.names()).toEqual([]);
  });

  it("the bot is not connected: 502, nothing changes", async () => {
    const id = await seedConvertible();
    botReady = false;
    const res = await convert(id, { to: "command", command: { new: newCommand } });
    expect(res.statusCode).toBe(502);
    expect(res.json().error.code).toBe("registration_failed");
    expect((await BehaviorDefinition.findByPk(id))!.getDataValue("triggerKind")).toBe("message");
  });

  it("storing fails after Discord accepted: the registration is taken back", async () => {
    const id = await seedConvertible();
    const create = vi
      .spyOn(BehaviorCommand, "create")
      .mockRejectedValueOnce(new Error("SQLITE_BUSY: database is locked"));
    const res = await convert(id, { to: "command", command: { new: newCommand } });
    create.mockRestore();
    expect(res.statusCode).toBe(500);
    expect(globalCmds.names()).toEqual([]);
    expect((await BehaviorDefinition.findByPk(id))!.getDataValue("triggerKind")).toBe("message");
  });

  it("storing fails and the registration cannot be taken back: audited as store_failed", async () => {
    const id = await seedConvertible();
    const create = vi
      .spyOn(BehaviorCommand, "create")
      .mockRejectedValueOnce(new Error("SQLITE_BUSY: database is locked"));
    globalCmds.delete.mockRejectedValueOnce(new Error("Missing Access"));
    const res = await convert(id, { to: "command", command: { new: newCommand } });
    create.mockRestore();
    expect(res.statusCode).toBe(500);
    expect(globalCmds.names()).toEqual(["weather"]);
    const entry = (await listAudit({ limit: 50 })).find(
      (e) => e.action === "behavior.trigger.convert" && e.target === `behavior:${id}`,
    );
    expect(entry).toMatchObject({
      context: {
        from: { kind: "message", patternValue: "!weather" },
        to: { kind: "command", name: "weather", created: true },
        outcome: "store_failed",
        registrationTakenBack: false,
      },
    });
  });

  it("refuses a name a plugin command holds (409 name_conflict, Discord untouched)", async () => {
    await PluginCommand.create({
      pluginId: 7,
      guildId: null,
      name: "weather",
      featureKey: null,
      manifestJson: JSON.stringify({
        name: "weather",
        description: "weather",
        scope: "global",
        integration_types: ["guild_install"],
        contexts: ["Guild"],
      }),
    } as Record<string, unknown>);
    const id = await seedConvertible();
    const res = await convert(id, { to: "command", command: { new: newCommand } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({ code: "name_conflict", field: "command.new.name" });
    expect(globalCmds.create).not.toHaveBeenCalled();
  });

  it("refuses the reserved /login and a name another behavior command holds", async () => {
    await seedLeaf(await seedCommand({ name: "weather" }));
    const id = await seedConvertible();
    for (const name of ["weather", "login"]) {
      const res = await convert(id, { to: "command", command: { new: { ...newCommand, name } } });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toMatchObject({ code: "name_conflict", field: "command.new.name" });
    }
  });

  it("checks Discord's rules on the new command, naming the nested field", async () => {
    const id = await seedConvertible();
    const res = await convert(id, {
      to: "command",
      command: { new: { ...newCommand, registration: "guild", guildId: "123456789012345678", contexts: ["BotDM"] } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatchObject({ code: "validation_failed", field: "command.new.contexts" });
  });

  it("a disabled behavior is stored without a registration", async () => {
    const id = await seedConvertible({ enabled: false });
    const res = await convert(id, { to: "command", command: { new: newCommand } });
    expect(res.statusCode).toBe(200);
    expect(res.json().registration).toEqual({ status: "removed" });
    expect(res.json().behavior.enabled).toBe(false);
    expect(globalCmds.create).not.toHaveBeenCalled();
  });

  it("drops a DM trigger's audience group, and the list it alone used", async () => {
    const id = await seedConvertible({
      surface: "bot_dm",
      stopOnMatch: false,
      audienceKind: "group",
      audienceGroupName: "ops",
    });
    await BehaviorGroupMember.create({ groupName: "ops", userId: "123456789012345678" });
    const res = await convert(id, {
      to: "command",
      command: { new: { ...newCommand, contexts: ["BotDM"] } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().behavior).toMatchObject({ id });
    expect(await BehaviorGroupMember.count()).toBe(0);
  });
});

describe("message → a subcommand of an existing command", () => {
  async function seedTree(): Promise<number> {
    const commandId = await seedCommand({ name: "nas" });
    await seedLeaf(commandId, { subcommand: "wake", title: "wake" });
    // registered as stored, as an earlier write would have left it
    await server.inject({ method: "POST", url: `/api/behavior-commands/${commandId}/resync` });
    globalCmds.edit.mockClear();
    return commandId;
  }

  it("adds the behavior as one more subcommand, registered before it is stored", async () => {
    const commandId = await seedTree();
    const id = await seedConvertible();
    const before = await keptState(id);
    const res = await convert(id, {
      to: "command",
      command: { existingId: commandId, subcommandName: "weather" },
      leafDescription: "Today's weather",
      replyVisibility: "public",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().command).toMatchObject({
      id: commandId,
      leaves: [
        { subcommand: "wake" },
        { id, subcommand: "weather", leafDescription: "Today's weather", replyVisibility: "public" },
      ],
    });
    expect(globalCmds.edit).toHaveBeenCalledTimes(1);
    expect(globalCmds.byName("nas")!.options!.map((o) => o.name)).toEqual(["wake", "weather"]);
    expect(await keptState(id)).toEqual(before);
  });

  it("refuses a command whose one leaf is its root: convert it to subcommands first", async () => {
    const commandId = await seedCommand({ name: "solo" });
    await seedLeaf(commandId);
    const id = await seedConvertible();
    const res = await convert(id, {
      to: "command",
      command: { existingId: commandId, subcommandName: "weather" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({ code: "invalid_tree", field: "command.existingId" });
    expect(res.json().error.message).toContain("convert-to-subcommands");
  });

  it("refuses a subcommand name the command already has", async () => {
    const commandId = await seedTree();
    const id = await seedConvertible();
    const res = await convert(id, {
      to: "command",
      command: { existingId: commandId, subcommandName: "wake" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({ code: "invalid_tree", field: "command.subcommandName" });
  });

  it("Discord refuses the updated command: 502, the message trigger and the command stay", async () => {
    const commandId = await seedTree();
    const id = await seedConvertible();
    globalCmds.edit.mockRejectedValueOnce(new Error("Invalid Form Body"));
    const res = await convert(id, {
      to: "command",
      command: { existingId: commandId, subcommandName: "weather" },
    });
    expect(res.statusCode).toBe(502);
    expect((await BehaviorDefinition.findByPk(id))!.getDataValue("triggerKind")).toBe("message");
    expect(await BehaviorDefinition.count({ where: { commandId } })).toBe(1);
    expect(globalCmds.byName("nas")!.options!.map((o) => o.name)).toEqual(["wake"]);
  });
});

// ── command → message ───────────────────────────────────────────────────────

describe("command → message", () => {
  it("the only leaf: stored as a message trigger, the command deleted and removed from Discord", async () => {
    const id = await seedConvertible();
    expect((await convert(id, { to: "command", command: { new: newCommand } })).statusCode).toBe(200);
    const before = await keptState(id);

    const res = await convert(id, toGuildMessage);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      registration: { status: "removed" },
      behavior: {
        kind: "message",
        id,
        surface: "guild",
        guildId: null,
        patternKind: "startswith",
        patternValue: "!weather",
        stopOnMatch: false,
        section: "guild:all",
      },
    });
    expect(await BehaviorCommand.count()).toBe(0);
    expect(globalCmds.names()).toEqual([]);
    expect(await keptState(id)).toEqual(before);
  });

  it("one of several subcommands: the command is registered again without it", async () => {
    const commandId = await seedCommand({ name: "nas" });
    await seedLeaf(commandId, { subcommand: "wake", title: "wake" });
    const id = await seedLeaf(commandId, {
      subcommand: "status",
      title: "status",
      sortOrder: 1,
      options: JSON.stringify([{ type: "string", name: "host", description: "host", required: false }]),
      replyVisibility: "private",
    });
    await server.inject({ method: "POST", url: `/api/behavior-commands/${commandId}/resync` });
    await BehaviorStat.create({ behaviorId: id, successCount: 2 });

    const res = await convert(id, {
      to: "message",
      location: "bot_dm",
      patternKind: "regex",
      patternValue: "^!status\\s+(\\S+)",
      audienceKind: "user",
      audienceUserId: "123456789012345678",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().registration).toMatchObject({ status: "registered" });
    expect(res.json().behavior).toMatchObject({
      id,
      kind: "message",
      surface: "bot_dm",
      audienceKind: "user",
      // a DM with the bot takes no reply visibility
      replyVisibility: null,
      stats: { successCount: 2 },
    });
    expect(globalCmds.byName("nas")!.options!.map((o) => o.name)).toEqual(["wake"]);
    const row = await BehaviorDefinition.findByPk(id);
    expect(row!.get({ plain: true })).toMatchObject({ commandId: null, subcommand: null, options: null });
    expect(await BehaviorCommand.count()).toBe(1);
  });

  it("goes to the end of the matching order", async () => {
    await seedMessageTrigger({ sortOrder: 7 });
    const commandId = await seedCommand();
    const id = await seedLeaf(commandId);
    const res = await convert(id, toGuildMessage);
    expect(res.statusCode).toBe(200);
    expect(res.json().behavior.sortOrder).toBe(8);
  });

  it("Discord refuses the command left behind: the conversion stands, reported as failed", async () => {
    const commandId = await seedCommand({ name: "nas" });
    await seedLeaf(commandId, { subcommand: "wake", title: "wake" });
    const id = await seedLeaf(commandId, { subcommand: "status", title: "status", sortOrder: 1 });
    await server.inject({ method: "POST", url: `/api/behavior-commands/${commandId}/resync` });
    globalCmds.edit.mockRejectedValueOnce(new Error("Missing Access"));

    const res = await convert(id, toGuildMessage);
    expect(res.statusCode).toBe(200);
    expect(res.json().registration).toMatchObject({
      status: "failed",
      targets: [{ target: "global", status: "failed" }],
    });
    expect(res.json().registration.reason).toContain("resynced");
    expect((await BehaviorDefinition.findByPk(id))!.getDataValue("triggerKind")).toBe("message");
  });

  it("checks the message trigger's rules (an audience only in DMs with the bot)", async () => {
    const id = await seedLeaf(await seedCommand());
    const res = await convert(id, { ...toGuildMessage, audienceKind: "user", audienceUserId: "123456789012345678" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatchObject({ code: "validation_failed", field: "audienceKind" });
  });
});

// ── refusals and the audit ──────────────────────────────────────────────────

describe("refusals", () => {
  it("the system login: 409 system_immutable", async () => {
    const id = await seedSystemLogin();
    const res = await convert(id, { to: "command", command: { new: newCommand } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("system_immutable");
  });

  it("a stale version: 409", async () => {
    const id = await seedConvertible();
    const res = await server.inject({
      method: "POST",
      url: `/api/behaviors/${id}/convert-trigger`,
      payload: { to: "command", command: { new: newCommand }, ifUpdatedAt: "2000-01-01T00:00:00.000Z" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({ code: "validation_failed", field: "ifUpdatedAt" });
  });

  it("the kind it already has, the other direction's fields, a missing version", async () => {
    const id = await seedConvertible();
    expect((await convert(id, toGuildMessage)).json().error).toMatchObject({ field: "to" });
    expect(
      (await convert(id, { to: "command", command: { new: newCommand }, patternValue: "x" })).json().error,
    ).toMatchObject({ code: "validation_failed", field: "patternValue" });
    expect((await convert(id, { to: "command" })).json().error).toMatchObject({ field: "command" });
    const res = await server.inject({
      method: "POST",
      url: `/api/behaviors/${id}/convert-trigger`,
      payload: { to: "command", command: { new: newCommand } },
    });
    expect(res.json().error).toMatchObject({ code: "validation_failed", field: "ifUpdatedAt" });
  });

  it("serves its schema with the others", async () => {
    const res = await server.inject({ method: "GET", url: "/api/behaviors/schema" });
    expect(res.json().convertTrigger).toMatchObject({ required: ["to", "ifUpdatedAt"] });
  });
});

describe("audit", () => {
  it("records from, to and the target command — never the webhook URL or secret", async () => {
    const id = await seedConvertible();
    await convert(id, { to: "command", command: { new: newCommand } });
    await convert(id, toGuildMessage);
    // newest first; earlier tests left entries of their own
    const entries = (await listAudit({ limit: 50 }))
      .filter((e) => e.action === "behavior.trigger.convert" && e.target === `behavior:${id}`)
      .slice(0, 2);
    const [back, forth] = entries;
    expect(forth).toMatchObject({
      target: `behavior:${id}`,
      context: {
        from: { kind: "message", location: "guild:all", patternValue: "!weather" },
        to: { kind: "command", name: "weather", subcommand: "", target: "global", created: true },
        registration: "registered",
      },
    });
    expect(back).toMatchObject({
      context: {
        from: { kind: "command", name: "weather", subcommand: "" },
        to: { kind: "message", location: "guild:all" },
        commandRemoved: true,
        registration: "removed",
      },
    });
    const text = JSON.stringify(entries);
    expect(text).not.toContain("hooks.example");
    expect(text).not.toContain("s3cret");
  });
});

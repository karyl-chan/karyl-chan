/**
 * S2 (#133)：CommandNamespace.check(name, target, exclude) —— 內建指令、
 * plugin_commands、所有 behavior 指令（含停用的）共用的 Discord 指令命名空間。
 *
 * 規則：全域指令與任何同名指令衝突（伺服器選單會出現兩個同名項目）；
 * 只有指定在不同伺服器的兩個指令可以同名。
 */

import { vi, describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";

vi.hoisted(() => {
  process.env.SQLITE_DB_PATH = ":memory:";
  process.env.ENCRYPTION_KEY = "a".repeat(64);
});

vi.mock("../src/modules/bot-events/bot-event-log.js", () => ({
  botEventLog: { record: vi.fn() },
}));

import { sequelize } from "../src/db.js";
import { PluginCommand } from "../src/modules/plugin-system/models/plugin-command.model.js";
import {
  registerInProcessCommand,
  _resetInProcessRegistry,
} from "../src/modules/builtin-features/in-process-command-registry.service.js";
import { CommandNamespace } from "../src/modules/command-system/command-namespace.js";
import { clearBehaviors, seedCommand, seedLeaf } from "./behavior-fixtures.js";

/** A behavior command named `ping` (global) with a root leaf. */
async function seedBehavior(
  command: Record<string, unknown>,
  leaf: Record<string, unknown> = {},
): Promise<number> {
  const id = await seedCommand(command);
  await seedLeaf(id, leaf);
  return id;
}

async function seedPluginCommand(opts: {
  pluginId: number;
  name: string;
  scope?: "global" | "guild";
  featureKey?: string;
  guildId?: string;
}): Promise<void> {
  await PluginCommand.create({
    pluginId: opts.pluginId,
    guildId: opts.guildId ?? null,
    name: opts.name,
    featureKey: opts.featureKey ?? null,
    manifestJson: JSON.stringify({
      name: opts.name,
      description: opts.name,
      scope: opts.scope ?? "global",
      integration_types: ["guild_install"],
      contexts: ["Guild"],
    }),
  } as Record<string, unknown>);
}

const ns = new CommandNamespace();

beforeAll(async () => {
  await sequelize.sync({ force: true });
});

beforeEach(async () => {
  await clearBehaviors();
  await PluginCommand.destroy({ where: {} });
});

afterEach(() => {
  _resetInProcessRegistry();
});

describe("CommandNamespace.check", () => {
  it("a free name is ok", async () => {
    expect(await ns.check("free", "global")).toEqual({ ok: true });
  });

  it("a command whose leaves are all disabled still owns its name", async () => {
    const id = await seedBehavior({}, { enabled: false });

    expect(await ns.check("ping", "global")).toEqual({
      ok: false,
      conflict: {
        name: "ping",
        target: "global",
        owner: { kind: "behavior_command", commandId: id },
      },
    });
  });

  it("commands in two different specific guilds may share a name", async () => {
    await seedBehavior({ registration: "guild", guildId: "g2" });

    expect(await ns.check("ping", "guild:g1")).toEqual({ ok: true });
    expect((await ns.check("ping", "guild:g2")).ok).toBe(false);
  });

  it("a global name conflicts with a guild command of the same name, both ways", async () => {
    await seedBehavior({ registration: "guild", guildId: "g1" });
    expect((await ns.check("ping", "global")).ok).toBe(false);

    await clearBehaviors();
    await seedBehavior({});
    expect((await ns.check("ping", "guild:g1")).ok).toBe(false);
  });

  it("a track-3 plugin command with scope=guild covers every guild", async () => {
    await seedPluginCommand({ pluginId: 7, name: "radio", scope: "guild" });

    expect(await ns.check("radio", "guild:g1")).toEqual({
      ok: false,
      conflict: {
        name: "radio",
        target: "all_guilds",
        owner: { kind: "plugin_command", pluginId: 7 },
      },
    });
  });

  it("guild-feature plugin commands own their name in every guild", async () => {
    await seedPluginCommand({
      pluginId: 7,
      name: "quest-game",
      featureKey: "quest-game",
      guildId: "g1",
    });

    expect((await ns.check("quest-game", "guild:g9")).ok).toBe(false);
  });

  it("excludes the caller's own commands", async () => {
    await seedPluginCommand({ pluginId: 7, name: "radio" });
    const id = await seedBehavior({ name: "mine" });

    expect(await ns.check("radio", "global", { pluginId: 7 })).toEqual({
      ok: true,
    });
    expect(await ns.check("mine", "global", { commandId: id })).toEqual({
      ok: true,
    });
    expect((await ns.check("radio", "global", { pluginId: 8 })).ok).toBe(false);
  });

  it("built-in in-process commands own their names (guild-scoped ones in every guild)", async () => {
    registerInProcessCommand({
      data: { name: "voice", description: "voice" },
      scope: "guild",
      handler: async () => {},
    });

    expect(await ns.check("voice", "guild:g1")).toEqual({
      ok: false,
      conflict: {
        name: "voice",
        target: "all_guilds",
        owner: { kind: "builtin" },
      },
    });
  });

  it("compares names case-insensitively against stored commands", async () => {
    await PluginCommand.create({
      pluginId: 7,
      guildId: null,
      name: "Radio",
      featureKey: null,
      manifestJson: JSON.stringify({ name: "Radio", scope: "global" }),
    } as Record<string, unknown>);

    expect((await ns.check("radio", "global")).ok).toBe(false);
    expect((await ns.check("RADIO", "global")).ok).toBe(false);
  });
});

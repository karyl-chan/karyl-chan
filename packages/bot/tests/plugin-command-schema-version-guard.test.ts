/**
 * #187：軌三（pluginCommands）的 schema_version 守衛。
 *
 * PluginCommandSource 只接受 plugin-wire `validateManifestProtocol` 也接受
 * 的 schema_version：沒有、null、或舊版的 "1"。SDK 1.x 的 buildManifest
 * 不再輸出這個欄位，舊守衛要求 "1"，所以這些 plugin 的軌三指令從來沒有
 * 註冊過。其他值（例如 "2"）代表這個 build 看不懂的 schema，維持 not_desired。
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
import { sequelize } from "../src/db.js";
import { Plugin } from "../src/modules/plugin-system/models/plugin.model.js";
import { PluginCommand } from "../src/modules/plugin-system/models/plugin-command.model.js";
import { PluginCommandSource } from "../src/modules/command-system/desired-command-source.js";
import { CommandReconciler } from "../src/modules/command-system/reconcile.service.js";

const TRACK3_CMD = {
  name: "radio",
  description: "radio",
  scope: "guild",
  integration_types: ["guild_install"],
  contexts: ["Guild"],
};

async function seedPlugin(manifest: Record<string, unknown>) {
  return Plugin.create({
    pluginKey: "p1",
    name: "p1",
    version: "1.0.0",
    url: "http://p1.invalid",
    enabled: true,
    status: "active",
    manifestJson: JSON.stringify(manifest),
  } as Record<string, unknown>);
}

async function seedTrack3Command(
  pluginId: number,
  cmd: Record<string, unknown>,
): Promise<number> {
  const row = await PluginCommand.create({
    pluginId,
    guildId: null,
    name: cmd.name,
    featureKey: null,
    manifestJson: JSON.stringify(cmd),
  } as Record<string, unknown>);
  return row.getDataValue("id") as number;
}

async function lookupWith(manifest: Record<string, unknown>) {
  const plugin = await seedPlugin(manifest);
  const id = await seedTrack3Command(plugin.getDataValue("id"), TRACK3_CMD);
  return new PluginCommandSource().lookup(id);
}

beforeAll(async () => {
  await sequelize.sync({ force: true });
});

beforeEach(async () => {
  await PluginCommand.destroy({ where: {} });
  await Plugin.destroy({ where: {} });
});

describe("PluginCommandSource — schema_version guard (#187)", () => {
  it("a manifest without schema_version (SDK 1.x) is desired", async () => {
    const res = await lookupWith({ sdk_version: "1.1.0" });
    expect(res.status).toBe("desired");
  });

  it('the legacy schema_version "1" is still desired', async () => {
    const res = await lookupWith({ schema_version: "1" });
    expect(res.status).toBe("desired");
  });

  it("schema_version null is desired, like the wire validator", async () => {
    const res = await lookupWith({ schema_version: null });
    expect(res.status).toBe("desired");
  });

  it('an unknown schema_version ("2") stays not_desired', async () => {
    const res = await lookupWith({ schema_version: "2" });
    expect(res).toMatchObject({ status: "not_desired" });
  });
});

describe("reconcile — an SDK 1.x plugin's track-3 commands register (#187)", () => {
  it("registers every plugin_commands entry of a manifest shaped like buildManifest output", async () => {
    // buildManifest（plugin-sdk 1.x）的輸出：只有 sdk_version，沒有 schema_version。
    // 指令形狀照 plugin-reminder 的三個 pluginCommands。
    const pluginCommands = ["remind-add", "remind-list", "remind-cancel"].map(
      (name) => ({
        name,
        description: name,
        scope: "guild",
        integration_types: ["guild_install"],
        contexts: ["Guild"],
        default_ephemeral: true,
      }),
    );
    const manifest = {
      sdk_version: "1.1.0",
      plugin: {
        id: "karyl-reminder",
        name: "Karyl Reminder",
        version: "0.1.0",
        url: "http://karyl-reminder:3000",
        healthcheck_path: "/health",
      },
      plugin_commands: pluginCommands,
    };
    expect(manifest).not.toHaveProperty("schema_version");
    const plugin = await seedPlugin(manifest);
    for (const cmd of manifest.plugin_commands) {
      await seedTrack3Command(plugin.getDataValue("id"), cmd);
    }
    const guild = { id: "g1", commands: statefulCommands() };
    const client = {
      application: { commands: statefulCommands() },
      guilds: { cache: new Map([["g1", guild]]) },
    } as unknown as Client;

    const report = await new CommandReconciler(() => client).reconcileAll();

    expect(report.errors).toEqual([]);
    expect(guild.commands.names()).toEqual([
      "remind-add",
      "remind-cancel",
      "remind-list",
    ]);
  });
});

interface CmdStub {
  id: string;
  name: string;
}

class FakeCollection extends Map<string, CmdStub> {
  find(fn: (v: CmdStub) => boolean): CmdStub | undefined {
    for (const v of this.values()) if (fn(v)) return v;
    return undefined;
  }
}

/** 最小的 Discord 指令管理器：create 存起來、fetch 回傳現況。 */
function statefulCommands() {
  const store = new Map<string, CmdStub>();
  let nextCommandId = 0;
  return {
    names: () => [...store.values()].map((c) => c.name).sort(),
    fetch: vi.fn(async () => new FakeCollection(store)),
    create: vi.fn(async (data: { name: string }) => {
      const cmd = { ...data, id: `c${++nextCommandId}` };
      store.set(cmd.id, cmd);
      return cmd;
    }),
    edit: vi.fn(async (id: string, data: { name: string }) => {
      const cmd = { ...data, id };
      store.set(id, cmd);
      return cmd;
    }),
    delete: vi.fn(async (id: string) => {
      store.delete(id);
    }),
  };
}

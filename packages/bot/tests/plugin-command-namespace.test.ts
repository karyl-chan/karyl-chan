/**
 * S2 (#133)：plugin 註冊的名稱衝突檢查改用 CommandNamespace（取代
 * findEnabledSlashCommandNames + 把所有指令當全域的舊檢查）。
 *  - 停用的 behavior 仍擁有它的名稱
 *  - 衝突依目標判斷（軌三 scope=guild 是 all_guilds）
 *  - 保守保留：Discord 即時快取裡已有的名稱仍不能用（自己的除外）
 */

import { vi, describe, it, expect, beforeAll, beforeEach } from "vitest";

vi.hoisted(() => {
  process.env.SQLITE_DB_PATH = ":memory:";
  process.env.ENCRYPTION_KEY = "a".repeat(64);
});

vi.mock("../src/modules/bot-events/bot-event-log.js", () => ({
  botEventLog: { record: vi.fn() },
}));

import { sequelize } from "../src/db.js";
import { clearBehaviors, seedCommand, seedLeaf } from "./behavior-fixtures.js";
import { PluginCommand } from "../src/modules/plugin-system/models/plugin-command.model.js";
import {
  ManifestCommandError,
  PluginCommandRegistry,
} from "../src/modules/plugin-system/plugin-command-registry.service.js";
import type { PluginManifest } from "../src/modules/plugin-system/plugin-registry.service.js";
import { CommandNamespace } from "../src/modules/command-system/command-namespace.js";

function manifestWith(
  cmds: Array<{ name: string; scope: "global" | "guild" }>,
): PluginManifest {
  return {
    plugin_commands: cmds.map((c) => ({
      name: c.name,
      description: c.name,
      scope: c.scope,
      integration_types: ["guild_install"],
      contexts: ["Guild"],
    })),
  } as unknown as PluginManifest;
}

/** A behavior command (global `/ping` by default) with a root leaf. */
async function seedBehavior(
  command: Record<string, unknown>,
  leaf: Record<string, unknown> = {},
): Promise<void> {
  await seedLeaf(await seedCommand(command), leaf);
}

const registry = new PluginCommandRegistry(
  () => null,
  () => new CommandNamespace(),
);

beforeAll(async () => {
  await sequelize.sync({ force: true });
});

beforeEach(async () => {
  await clearBehaviors();
  await PluginCommand.destroy({ where: {} });
});

describe("PluginCommandRegistry.assertNoCollisions via CommandNamespace", () => {
  it("rejects a name owned by a disabled behavior", async () => {
    await seedBehavior({}, { enabled: false });

    await expect(
      registry.assertNoCollisions(
        "p1",
        1,
        manifestWith([{ name: "ping", scope: "global" }]),
      ),
    ).rejects.toThrow(ManifestCommandError);
  });

  it("rejects a scope=guild command that a specific-guild behavior already uses", async () => {
    await seedBehavior({
      name: "radio",
      registration: "guild",
      guildId: "g1",
    });

    await expect(
      registry.assertNoCollisions(
        "p1",
        1,
        manifestWith([{ name: "radio", scope: "guild" }]),
      ),
    ).rejects.toThrow(/behavior/);
  });

  it("rejects a name another plugin already registered", async () => {
    await PluginCommand.create({
      pluginId: 2,
      guildId: null,
      name: "radio",
      featureKey: null,
      manifestJson: JSON.stringify({ name: "radio", scope: "global" }),
    } as Record<string, unknown>);

    await expect(
      registry.assertNoCollisions(
        "p1",
        1,
        manifestWith([{ name: "radio", scope: "global" }]),
      ),
    ).rejects.toThrow(/id=2/);
  });

  it("lets a plugin re-register its own commands", async () => {
    await PluginCommand.create({
      pluginId: 1,
      guildId: null,
      name: "radio",
      featureKey: null,
      manifestJson: JSON.stringify({ name: "radio", scope: "global" }),
    } as Record<string, unknown>);

    await expect(
      registry.assertNoCollisions(
        "p1",
        1,
        manifestWith([{ name: "radio", scope: "global" }]),
      ),
    ).resolves.toBeUndefined();
  });

  it("keeps /login reserved for the system login command", async () => {
    await expect(
      registry.assertNoCollisions(
        "p1",
        1,
        manifestWith([{ name: "login", scope: "global" }]),
      ),
    ).rejects.toThrow(ManifestCommandError);
  });

  it("still refuses names the bot already has registered with Discord (live cache), except the plugin's own", async () => {
    await PluginCommand.create({
      pluginId: 1,
      guildId: null,
      name: "mine",
      featureKey: null,
      manifestJson: JSON.stringify({ name: "mine", scope: "global" }),
    } as Record<string, unknown>);
    const cache = (names: string[]) => ({
      cache: new Map(names.map((n, i) => [`id${i}`, { name: n }])),
    });
    const liveRegistry = new PluginCommandRegistry(
      () =>
        ({
          application: { commands: cache(["leftover"]) },
          guilds: {
            cache: new Map([["g1", { id: "g1", commands: cache(["mine", "guild-only"]) }]]),
          },
        }) as never,
      () => new CommandNamespace(),
    );

    await expect(
      liveRegistry.assertNoCollisions(
        "p1",
        1,
        manifestWith([{ name: "leftover", scope: "global" }]),
      ),
    ).rejects.toThrow(ManifestCommandError);
    await expect(
      liveRegistry.assertNoCollisions(
        "p1",
        1,
        manifestWith([{ name: "guild-only", scope: "guild" }]),
      ),
    ).rejects.toThrow(ManifestCommandError);
    await expect(
      liveRegistry.assertNoCollisions(
        "p1",
        1,
        manifestWith([{ name: "mine", scope: "global" }]),
      ),
    ).resolves.toBeUndefined();
  });

  it("refuses a guild-feature command whose name a behavior already uses", async () => {
    await seedBehavior({
      name: "quest",
      registration: "guild",
      guildId: "g1",
    });

    await expect(
      registry.assertNoCollisions("p1", 1, featureManifest(["quest"])),
    ).rejects.toThrow(/behavior/);
  });

  it("lets a plugin re-register its own guild-feature commands", async () => {
    // 正式站的 radio / quest-game / xiangqi 只有 feature 指令：每個開了
    // feature 的伺服器各一列（guildId 有值、featureKey 非 null）
    for (const g of ["g1", "g2"]) {
      await PluginCommand.create({
        pluginId: 1,
        guildId: g,
        name: "quest",
        featureKey: "quest",
        manifestJson: JSON.stringify({ name: "quest" }),
      } as Record<string, unknown>);
    }

    await expect(
      registry.assertNoCollisions("p1", 1, featureManifest(["quest"])),
    ).resolves.toBeUndefined();
    // 另一個 plugin 想用同名 feature 指令則被擋
    await expect(
      registry.assertNoCollisions("p2", 2, featureManifest(["quest"])),
    ).rejects.toThrow(/id=1/);
  });
});

function featureManifest(names: string[]): PluginManifest {
  return {
    guild_features: [
      {
        key: "quest",
        name: "Quest",
        description: "quest",
        commands: names.map((name) => ({ name, description: name })),
      },
    ],
  } as unknown as PluginManifest;
}

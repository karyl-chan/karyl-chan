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
import { Behavior } from "../src/modules/behavior/models/behavior.model.js";
import { PluginCommand } from "../src/modules/plugin-system/models/plugin-command.model.js";
import {
  ManifestCommandError,
  PluginCommandRegistry,
} from "../src/modules/plugin-system/plugin-command-registry.service.js";
import type { PluginManifest } from "../src/modules/plugin-system/plugin-registry.service.js";
import { CommandNamespace } from "../src/modules/command-system/command-namespace.js";
import { encryptSecret } from "../src/utils/crypto.js";

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

async function seedBehavior(overrides: Record<string, unknown>): Promise<void> {
  await Behavior.create({
    title: "b",
    enabled: true,
    sortOrder: 0,
    source: "custom",
    triggerType: "slash_command",
    slashCommandName: "ping",
    slashCommandDescription: "ping",
    scope: "global",
    integrationTypes: "guild_install",
    contexts: "Guild",
    audienceKind: "all",
    webhookUrl: encryptSecret("http://example.invalid/hook"),
    scopeTabId: 1,
    ...overrides,
  } as Record<string, unknown>);
}

const registry = new PluginCommandRegistry(
  () => null,
  () => new CommandNamespace(),
);

beforeAll(async () => {
  await sequelize.sync({ force: true });
});

beforeEach(async () => {
  await Behavior.destroy({ where: {} });
  await PluginCommand.destroy({ where: {} });
});

describe("PluginCommandRegistry.assertNoCollisions via CommandNamespace", () => {
  it("rejects a name owned by a disabled behavior", async () => {
    await seedBehavior({ enabled: false });

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
      slashCommandName: "radio",
      scope: "guild",
      placementGuildId: "g1",
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
});

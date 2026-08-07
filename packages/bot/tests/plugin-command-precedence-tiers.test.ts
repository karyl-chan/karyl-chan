/**
 * #32 — the Precedence Tiers, as seen from command registration.
 *
 * The command registry decides, per (feature, guild), whether a
 * feature's slash commands exist in that guild, and that decision is
 * the Precedence Tiers: Guild Override → Operator Default → Manifest
 * Default → false. Nothing pinned it here before, so a divergence from
 * the Feature Reach module surfaced only as ghost or missing slash
 * commands — the hardest kind of bug to notice.
 *
 * These cases nail the full tier matrix at all three registry entry
 * points (sync, syncFeatureCommandsAcrossGuilds,
 * syncFeatureCommandsForNewGuild) against the real models, so routing
 * them through the shared resolvePrecedenceTiers is provably
 * behaviour-preserving.
 */
import { vi, describe, it, expect, beforeAll, beforeEach } from "vitest";

vi.hoisted(() => {
  process.env.SQLITE_DB_PATH = ":memory:";
  process.env.NODE_ENV = "test";
});

import type { Client, Guild } from "discord.js";
import { sequelize } from "../src/db.js";
import {
  Plugin,
  upsertPluginRegistration,
  type PluginRow,
} from "../src/modules/plugin-system/models/plugin.model.js";
import { PluginCommand } from "../src/modules/plugin-system/models/plugin-command.model.js";
import {
  PluginGuildFeature,
  upsertFeatureRow,
} from "../src/modules/feature-toggle/models/plugin-guild-feature.model.js";
import {
  PluginFeatureDefault,
  upsertFeatureDefault,
} from "../src/modules/feature-toggle/models/plugin-feature-default.model.js";
import {
  pluginCommandRegistry,
  setPluginCommandBotClient,
} from "../src/modules/plugin-system/plugin-command-registry.service.js";
import type { PluginManifest } from "../src/modules/plugin-system/plugin-registry.service.js";

let snowflake = 0;

type FakeGuild = {
  id: string;
  commands: {
    create: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
  };
};

function makeFakeBot(guildIds: string[]) {
  const guilds = new Map<string, FakeGuild>(
    guildIds.map((id) => [
      id,
      {
        id,
        commands: {
          create: vi.fn(async () => ({ id: `cmd-${++snowflake}` })),
          delete: vi.fn(async () => undefined),
        },
      },
    ]),
  );
  return {
    application: { commands: { cache: new Map(), delete: vi.fn() } },
    guilds: { cache: guilds },
  } as unknown as Client;
}

function fakeGuild(bot: Client, guildId: string): FakeGuild {
  return (bot.guilds.cache as unknown as Map<string, FakeGuild>).get(guildId)!;
}

interface FeatureSpec {
  key: string;
  enabled_by_default?: boolean;
}

/** One command per feature, named `<key>-cmd`, so a registered row
 *  identifies its feature unambiguously. */
function makeManifest(features: FeatureSpec[]): PluginManifest {
  return {
    plugin: {
      id: "tiers-plugin",
      name: "Tiers Plugin",
      version: "1.0.0",
      url: "http://tiers-plugin:3000",
    },
    guild_features: features.map((f) => ({
      name: f.key,
      commands: [{ name: `${f.key}-cmd`, description: f.key }],
      ...f,
    })),
  } as unknown as PluginManifest;
}

async function makePluginRow(manifest: PluginManifest): Promise<PluginRow> {
  return upsertPluginRegistration({
    pluginKey: "tiers-plugin",
    name: "Tiers Plugin",
    version: "1.0.0",
    url: "http://tiers-plugin:3000",
    manifestJson: JSON.stringify(manifest),
    tokenHash: "h",
  });
}

/** Every feature command row currently persisted, as sorted
 *  `guild/feature` pairs — the observable "which commands exist where". */
async function registered(pluginId: number): Promise<string[]> {
  const rows = await PluginCommand.findAll({ where: { pluginId } });
  return rows
    .filter((r) => r.getDataValue("featureKey") !== null)
    .map(
      (r) => `${r.getDataValue("guildId")}/${r.getDataValue("featureKey")}`,
    )
    .sort();
}

beforeAll(async () => {
  await sequelize.sync({ force: true });
});

beforeEach(async () => {
  await Plugin.destroy({ where: {} });
  await PluginCommand.destroy({ where: {} });
  await PluginGuildFeature.destroy({ where: {} });
  await PluginFeatureDefault.destroy({ where: {} });
});

describe("sync() resolves the Precedence Tiers per (feature, guild)", () => {
  it("a Guild Override beats both defaults, in both directions", async () => {
    const bot = makeFakeBot(["g1"]);
    setPluginCommandBotClient(bot);
    const manifest = makeManifest([
      { key: "on-by-default", enabled_by_default: true },
      { key: "off-by-default", enabled_by_default: false },
    ]);
    const plugin = await makePluginRow(manifest);
    // Operator Defaults agree with the manifest; the guild rows invert
    // both, so only the override can explain the outcome.
    await upsertFeatureDefault(plugin.id, "on-by-default", true);
    await upsertFeatureDefault(plugin.id, "off-by-default", false);
    await upsertFeatureRow({
      pluginId: plugin.id,
      guildId: "g1",
      featureKey: "on-by-default",
      enabled: false,
    });
    await upsertFeatureRow({
      pluginId: plugin.id,
      guildId: "g1",
      featureKey: "off-by-default",
      enabled: true,
    });

    await pluginCommandRegistry.sync(plugin, manifest);
    expect(await registered(plugin.id)).toEqual(["g1/off-by-default"]);
  });

  it("the Operator Default decides where no Guild Override exists", async () => {
    const bot = makeFakeBot(["g1"]);
    setPluginCommandBotClient(bot);
    const manifest = makeManifest([
      { key: "manifest-off", enabled_by_default: false },
      { key: "manifest-on", enabled_by_default: true },
    ]);
    const plugin = await makePluginRow(manifest);
    await upsertFeatureDefault(plugin.id, "manifest-off", true);
    await upsertFeatureDefault(plugin.id, "manifest-on", false);

    await pluginCommandRegistry.sync(plugin, manifest);
    expect(await registered(plugin.id)).toEqual(["g1/manifest-off"]);
  });

  it("the Manifest Default is the last tier before off", async () => {
    const bot = makeFakeBot(["g1"]);
    setPluginCommandBotClient(bot);
    // `omitted` declares no enabled_by_default at all — the bottom
    // tier must read it as false rather than as "nothing to say".
    const manifest = makeManifest([
      { key: "declared-on", enabled_by_default: true },
      { key: "declared-off", enabled_by_default: false },
      { key: "omitted" },
    ]);
    const plugin = await makePluginRow(manifest);

    await pluginCommandRegistry.sync(plugin, manifest);
    expect(await registered(plugin.id)).toEqual(["g1/declared-on"]);
  });

  it("resolves each guild independently", async () => {
    const bot = makeFakeBot(["g1", "g2", "g3"]);
    setPluginCommandBotClient(bot);
    const manifest = makeManifest([{ key: "f", enabled_by_default: true }]);
    const plugin = await makePluginRow(manifest);
    await upsertFeatureRow({
      pluginId: plugin.id,
      guildId: "g2",
      featureKey: "f",
      enabled: false,
    });

    await pluginCommandRegistry.sync(plugin, manifest);
    expect(await registered(plugin.id)).toEqual(["g1/f", "g3/f"]);
  });

  it("a tier flipping off removes commands already registered in that guild", async () => {
    const bot = makeFakeBot(["g1"]);
    setPluginCommandBotClient(bot);
    const manifest = makeManifest([{ key: "f", enabled_by_default: true }]);
    const plugin = await makePluginRow(manifest);
    await pluginCommandRegistry.sync(plugin, manifest);
    expect(await registered(plugin.id)).toEqual(["g1/f"]);

    // Operator sets the "All Servers" default to off — the next sync
    // must strip the command, not leave a ghost the user can invoke.
    await upsertFeatureDefault(plugin.id, "f", false);
    await pluginCommandRegistry.sync(plugin, manifest);
    expect(await registered(plugin.id)).toEqual([]);
    expect(fakeGuild(bot, "g1").commands.delete).toHaveBeenCalledTimes(1);
  });

  it("registers nothing for a feature that declares no commands", async () => {
    const bot = makeFakeBot(["g1"]);
    setPluginCommandBotClient(bot);
    const manifest = {
      plugin: {
        id: "tiers-plugin",
        name: "Tiers Plugin",
        version: "1.0.0",
        url: "http://tiers-plugin:3000",
      },
      guild_features: [{ key: "f", name: "f", enabled_by_default: true }],
    } as unknown as PluginManifest;
    const plugin = await makePluginRow(manifest);

    await pluginCommandRegistry.sync(plugin, manifest);
    expect(await registered(plugin.id)).toEqual([]);
    expect(fakeGuild(bot, "g1").commands.create).not.toHaveBeenCalled();
  });
});

describe("syncFeatureCommandsAcrossGuilds() re-applies the same tiers", () => {
  it("registers where the feature resolves on and deletes where it resolves off", async () => {
    const bot = makeFakeBot(["g1", "g2"]);
    setPluginCommandBotClient(bot);
    const manifest = makeManifest([{ key: "f", enabled_by_default: true }]);
    const plugin = await makePluginRow(manifest);
    await pluginCommandRegistry.sync(plugin, manifest);
    expect(await registered(plugin.id)).toEqual(["g1/f", "g2/f"]);

    await upsertFeatureRow({
      pluginId: plugin.id,
      guildId: "g1",
      featureKey: "f",
      enabled: false,
    });
    await pluginCommandRegistry.syncFeatureCommandsAcrossGuilds(
      plugin,
      manifest,
      "f",
    );
    expect(await registered(plugin.id)).toEqual(["g2/f"]);
  });

  it("the Operator Default overrides the Manifest Default in every guild", async () => {
    const bot = makeFakeBot(["g1", "g2"]);
    setPluginCommandBotClient(bot);
    const manifest = makeManifest([{ key: "f", enabled_by_default: false }]);
    const plugin = await makePluginRow(manifest);
    await pluginCommandRegistry.syncFeatureCommandsAcrossGuilds(
      plugin,
      manifest,
      "f",
    );
    expect(await registered(plugin.id)).toEqual([]);

    await upsertFeatureDefault(plugin.id, "f", true);
    await pluginCommandRegistry.syncFeatureCommandsAcrossGuilds(
      plugin,
      manifest,
      "f",
    );
    expect(await registered(plugin.id)).toEqual(["g1/f", "g2/f"]);
  });

  it("a Guild Override still wins over a freshly set Operator Default", async () => {
    const bot = makeFakeBot(["g1", "g2"]);
    setPluginCommandBotClient(bot);
    const manifest = makeManifest([{ key: "f", enabled_by_default: false }]);
    const plugin = await makePluginRow(manifest);
    await upsertFeatureDefault(plugin.id, "f", false);
    await upsertFeatureRow({
      pluginId: plugin.id,
      guildId: "g1",
      featureKey: "f",
      enabled: true,
    });

    await pluginCommandRegistry.syncFeatureCommandsAcrossGuilds(
      plugin,
      manifest,
      "f",
    );
    expect(await registered(plugin.id)).toEqual(["g1/f"]);
  });
});

describe("syncFeatureCommandsForNewGuild() resolves the full Precedence Tiers", () => {
  it("prefers the Operator Default over the Manifest Default", async () => {
    const bot = makeFakeBot(["g1"]);
    setPluginCommandBotClient(bot);
    const manifest = makeManifest([
      { key: "manifest-off", enabled_by_default: false },
      { key: "manifest-on", enabled_by_default: true },
    ]);
    const plugin = await makePluginRow(manifest);
    await upsertFeatureDefault(plugin.id, "manifest-off", true);
    await upsertFeatureDefault(plugin.id, "manifest-on", false);

    await pluginCommandRegistry.syncFeatureCommandsForNewGuild({
      id: "g1",
    } as unknown as Guild);
    expect(await registered(plugin.id)).toEqual(["g1/manifest-off"]);
  });

  it("falls back to the Manifest Default when no Operator Default is set", async () => {
    const bot = makeFakeBot(["g1"]);
    setPluginCommandBotClient(bot);
    const manifest = makeManifest([
      { key: "on", enabled_by_default: true },
      { key: "off", enabled_by_default: false },
    ]);
    const plugin = await makePluginRow(manifest);

    await pluginCommandRegistry.syncFeatureCommandsForNewGuild({
      id: "g1",
    } as unknown as Guild);
    expect(await registered(plugin.id)).toEqual(["g1/on"]);
  });

  it("honours a Guild Override surviving a previous membership (#61: re-join keeps your settings)", async () => {
    const bot = makeFakeBot(["g1"]);
    setPluginCommandBotClient(bot);
    const manifest = makeManifest([{ key: "f", enabled_by_default: true }]);
    const plugin = await makePluginRow(manifest);
    // The bot left g1 once and rejoined; the old row survived. Ruling
    // on #61: the override counts — re-join means "your settings
    // survived", and the join path and sync() must agree so the
    // command can never flip-flop.
    await upsertFeatureRow({
      pluginId: plugin.id,
      guildId: "g1",
      featureKey: "f",
      enabled: false,
    });

    await pluginCommandRegistry.syncFeatureCommandsForNewGuild({
      id: "g1",
    } as unknown as Guild);
    expect(await registered(plugin.id)).toEqual([]);

    // The next full sync agrees — nothing appears, nothing vanishes.
    await pluginCommandRegistry.sync(plugin, manifest);
    expect(await registered(plugin.id)).toEqual([]);
  });

  it("honours a surviving enabled-override over a default-off manifest (#61 mirror)", async () => {
    const bot = makeFakeBot(["g1"]);
    setPluginCommandBotClient(bot);
    const manifest = makeManifest([{ key: "f", enabled_by_default: false }]);
    const plugin = await makePluginRow(manifest);
    await upsertFeatureRow({
      pluginId: plugin.id,
      guildId: "g1",
      featureKey: "f",
      enabled: true,
    });

    await pluginCommandRegistry.syncFeatureCommandsForNewGuild({
      id: "g1",
    } as unknown as Guild);
    expect(await registered(plugin.id)).toEqual(["g1/f"]);

    await pluginCommandRegistry.sync(plugin, manifest);
    expect(await registered(plugin.id)).toEqual(["g1/f"]);
  });

  it("skips plugins that are disabled or inactive", async () => {
    const bot = makeFakeBot(["g1"]);
    setPluginCommandBotClient(bot);
    const manifest = makeManifest([{ key: "f", enabled_by_default: true }]);
    const plugin = await makePluginRow(manifest);
    await Plugin.update({ enabled: false }, { where: { id: plugin.id } });

    await pluginCommandRegistry.syncFeatureCommandsForNewGuild({
      id: "g1",
    } as unknown as Guild);
    expect(await registered(plugin.id)).toEqual([]);
  });
});

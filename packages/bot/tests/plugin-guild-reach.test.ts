/**
 * Guild Reach (#129) — whether a plugin may serve a guild outside event
 * delivery (component / modal dispatch, guild-targeted RPC). Two grounds:
 * Feature Reach for any declared guild feature, or Command Reach — a
 * track-3 `plugin_commands[]` command usable in guilds. Track 1 feature
 * commands never confer Command Reach. DB-backed (sqlite :memory:) so the
 * rule runs against the real plugin_commands / feature tables.
 */
import { vi, describe, it, expect, beforeAll, beforeEach } from "vitest";

vi.hoisted(() => {
  process.env.SQLITE_DB_PATH = ":memory:";
});

import { sequelize } from "../src/db.js";
import { PluginCommand } from "../src/modules/plugin-system/models/plugin-command.model.js";
import { ReconcilerOwnedCommand } from "../src/modules/command-system/models/reconciler-owned-command.model.js";
import {
  PluginGuildFeature,
  upsertFeatureRow,
} from "../src/modules/feature-toggle/models/plugin-guild-feature.model.js";
import { PluginFeatureDefault } from "../src/modules/feature-toggle/models/plugin-feature-default.model.js";
import { featureReachResolver } from "../src/modules/feature-toggle/feature-reach-resolver.js";
import { hasGuildReach } from "../src/modules/plugin-system/plugin-guild-reach.js";
import type { PluginRow } from "../src/modules/plugin-system/models/plugin.model.js";
import type { PluginManifest } from "@karyl-chan/plugin-wire";

const PLUGIN_ID = 11;
const GUILD = "g1";

interface Track3 {
  name: string;
  scope: "guild" | "global";
  contexts: Array<"Guild" | "BotDM" | "PrivateChannel">;
  integration_types?: Array<"guild_install" | "user_install">;
}

function manifest(opts: {
  features?: { key: string; enabled_by_default?: boolean }[];
  pluginCommands?: Track3[];
  /** Omitted by default — the shape SDK 1.x buildManifest emits (#187). */
  schemaVersion?: string;
}): PluginManifest {
  return {
    ...(opts.schemaVersion === undefined
      ? {}
      : { schema_version: opts.schemaVersion }),
    plugin: { id: "p", name: "p", version: "0", url: "http://p.invalid" },
    guild_features: (opts.features ?? []).map((f) => ({ name: f.key, ...f })),
    plugin_commands: (opts.pluginCommands ?? []).map((c) => ({
      description: c.name,
      integration_types: ["guild_install"],
      ...c,
    })),
  } as unknown as PluginManifest;
}

function pluginRow(
  m: PluginManifest,
  over: Partial<PluginRow> = {},
): PluginRow {
  return {
    id: PLUGIN_ID,
    pluginKey: "p",
    name: "p",
    version: "0",
    url: "http://p.invalid",
    manifestJson: JSON.stringify(m),
    status: "active",
    enabled: true,
    dispatchHmacKey: "k",
    ...over,
  } as PluginRow;
}

/**
 * Seed the plugin_commands rows registration would write for this
 * manifest, plus the reconciler roster rows a successful reconcile would
 * leave: by default the guild copy in GUILD (scope guild) or the global
 * command. `registeredIn: []` = not reconciled into any guild yet.
 */
async function seedTrack3(
  commands: Track3[],
  opts: { adminEnabled?: boolean; registeredIn?: string[] } = {},
): Promise<void> {
  for (const c of commands) {
    const guildIds =
      opts.registeredIn ?? (c.scope === "guild" ? [GUILD] : [null]);
    for (const guildId of guildIds) {
      await ReconcilerOwnedCommand.create({
        name: c.name,
        scope: guildId === null ? "global" : "guild",
        guildId,
        ownedAt: new Date(),
      });
    }
    await PluginCommand.create({
      pluginId: PLUGIN_ID,
      guildId: null,
      name: c.name,
      discordCommandId: null,
      featureKey: null,
      manifestJson: JSON.stringify({
        description: c.name,
        integration_types: ["guild_install"],
        ...c,
      }),
      adminEnabled: opts.adminEnabled ?? true,
    });
  }
}

const allFeaturesOff = [{ key: "f", enabled_by_default: false }];

beforeAll(async () => {
  await sequelize.sync({ force: true });
});

beforeEach(async () => {
  featureReachResolver.clear();
  await PluginCommand.destroy({ where: {} });
  await ReconcilerOwnedCommand.destroy({ where: {} });
  await PluginGuildFeature.destroy({ where: {} });
  await PluginFeatureDefault.destroy({ where: {} });
});

describe("hasGuildReach", () => {
  it("a scope=guild track-3 command grants reach in a guild where every feature is off", async () => {
    const cmds: Track3[] = [
      { name: "radio", scope: "guild", contexts: ["Guild"] },
    ];
    const m = manifest({ features: allFeaturesOff, pluginCommands: cmds });
    await seedTrack3(cmds);

    expect(await hasGuildReach(pluginRow(m), GUILD, m)).toBe(true);
  });

  it("a track-3 command not registered in this guild grants nothing", async () => {
    const cmds: Track3[] = [
      { name: "radio", scope: "guild", contexts: ["Guild"] },
    ];
    const m = manifest({ features: allFeaturesOff, pluginCommands: cmds });

    // Not reconciled yet.
    await seedTrack3(cmds, { registeredIn: [] });
    expect(await hasGuildReach(pluginRow(m), GUILD, m)).toBe(false);

    // Registered, but only in another guild.
    await ReconcilerOwnedCommand.create({
      name: "radio",
      scope: "guild",
      guildId: "g2",
      ownedAt: new Date(),
    });
    expect(await hasGuildReach(pluginRow(m), GUILD, m)).toBe(false);
    expect(await hasGuildReach(pluginRow(m), "g2", m)).toBe(true);
  });

  it("without a track-3 command, every feature off still denies reach", async () => {
    const m = manifest({ features: allFeaturesOff });

    expect(await hasGuildReach(pluginRow(m), GUILD, m)).toBe(false);
  });

  it("an enabled feature grants reach on its own", async () => {
    const m = manifest({ features: allFeaturesOff });
    await upsertFeatureRow({
      pluginId: PLUGIN_ID,
      guildId: GUILD,
      featureKey: "f",
      enabled: true,
    });

    expect(await hasGuildReach(pluginRow(m), GUILD, m)).toBe(true);
  });

  it("a Track 1 feature command row never confers reach", async () => {
    const m = manifest({ features: allFeaturesOff });
    await PluginCommand.create({
      pluginId: PLUGIN_ID,
      guildId: GUILD,
      name: "feat-cmd",
      discordCommandId: null,
      featureKey: "f",
      manifestJson: JSON.stringify({ name: "feat-cmd", description: "x" }),
      adminEnabled: true,
    });

    expect(await hasGuildReach(pluginRow(m), GUILD, m)).toBe(false);
  });

  it("an admin-disabled track-3 command is not usable, so it grants nothing", async () => {
    const cmds: Track3[] = [
      { name: "radio", scope: "guild", contexts: ["Guild"] },
    ];
    const m = manifest({ features: allFeaturesOff, pluginCommands: cmds });
    await seedTrack3(cmds, { adminEnabled: false });

    expect(await hasGuildReach(pluginRow(m), GUILD, m)).toBe(false);
  });

  it("a global track-3 command grants reach only when it is usable in a guild context", async () => {
    const dmOnly: Track3[] = [
      {
        name: "dm-only",
        scope: "global",
        contexts: ["BotDM", "PrivateChannel"],
        integration_types: ["user_install"],
      },
    ];
    const mDm = manifest({ features: allFeaturesOff, pluginCommands: dmOnly });
    await seedTrack3(dmOnly);
    expect(await hasGuildReach(pluginRow(mDm), GUILD, mDm)).toBe(false);

    const inGuild: Track3[] = [
      {
        name: "everywhere",
        scope: "global",
        contexts: ["Guild", "BotDM"],
        integration_types: ["guild_install", "user_install"],
      },
    ];
    const mAll = manifest({
      features: allFeaturesOff,
      pluginCommands: inGuild,
    });
    await seedTrack3(inGuild);
    expect(await hasGuildReach(pluginRow(mAll), GUILD, mAll)).toBe(true);
  });

  it("a track-3 command the reconciler would not register grants nothing (disabled plugin, unsupported manifest)", async () => {
    const cmds: Track3[] = [
      { name: "radio", scope: "guild", contexts: ["Guild"] },
    ];
    await seedTrack3(cmds);

    const m = manifest({ features: allFeaturesOff, pluginCommands: cmds });
    expect(
      await hasGuildReach(pluginRow(m, { enabled: false }), GUILD, m),
    ).toBe(false);

    // Mirrors the reconciler's schema_version guard (PluginCommandSource):
    // a version this build does not understand registers nothing.
    const future = manifest({
      features: allFeaturesOff,
      pluginCommands: cmds,
      schemaVersion: "2",
    });
    expect(await hasGuildReach(pluginRow(future), GUILD, future)).toBe(false);
  });

  it("the legacy schema_version \"1\" still grants Command Reach", async () => {
    const cmds: Track3[] = [
      { name: "remind", scope: "guild", contexts: ["Guild"] },
    ];
    await seedTrack3(cmds);
    const legacy = manifest({
      features: allFeaturesOff,
      pluginCommands: cmds,
      schemaVersion: "1",
    });

    expect(await hasGuildReach(pluginRow(legacy), GUILD, legacy)).toBe(true);
  });

  it("another plugin's track-3 command does not lend reach", async () => {
    await PluginCommand.create({
      pluginId: PLUGIN_ID + 1,
      guildId: null,
      name: "other",
      discordCommandId: null,
      featureKey: null,
      manifestJson: JSON.stringify({
        name: "other",
        description: "x",
        scope: "guild",
        contexts: ["Guild"],
        integration_types: ["guild_install"],
      }),
      adminEnabled: true,
    });
    await ReconcilerOwnedCommand.create({
      name: "other",
      scope: "guild",
      guildId: GUILD,
      ownedAt: new Date(),
    });
    const m = manifest({ features: allFeaturesOff });

    expect(await hasGuildReach(pluginRow(m), GUILD, m)).toBe(false);
  });
});

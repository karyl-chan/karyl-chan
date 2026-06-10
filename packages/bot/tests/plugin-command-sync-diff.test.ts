/**
 * PM-7.3 — diff-based command sync.
 *
 * A re-register with an unchanged manifest must cost ZERO Discord
 * writes (the dev-loop "restart → recreate commands × guilds"
 * amplification is what rate-limited the 2026-06-11 incident's bot),
 * while changed/new/removed commands still hit Discord exactly where
 * needed. Rate-limit rejections propagate as
 * CommandSyncRateLimitedError instead of being swallowed.
 */
import { vi, describe, it, expect, beforeAll, beforeEach } from "vitest";

vi.hoisted(() => {
  process.env.SQLITE_DB_PATH = ":memory:";
  process.env.NODE_ENV = "test";
});

import { RateLimitError } from "discord.js";
import type { Client } from "discord.js";
import { sequelize } from "../src/db.js";
import { Plugin, upsertPluginRegistration } from "../src/modules/plugin-system/models/plugin.model.js";
import { PluginCommand } from "../src/modules/plugin-system/models/plugin-command.model.js";
import {
  pluginCommandRegistry,
  setPluginCommandBotClient,
  CommandSyncRateLimitedError,
  type PluginManifest,
} from "../src/modules/plugin-system/plugin-command-registry.service.js";

let snowflake = 0;
function makeFakeBot(guildIds: string[]) {
  const guilds = new Map(
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

function makeManifest(cmds: Array<{ name: string; description: string }>) {
  return {
    plugin: {
      id: "diff-plugin",
      name: "Diff Plugin",
      version: "1.0.0",
      url: "http://diff-plugin:3000",
    },
    guild_features: [
      {
        key: "music",
        name: "Music",
        enabled_by_default: true,
        commands: cmds,
      },
    ],
  } as unknown as PluginManifest;
}

async function makePluginRow() {
  return upsertPluginRegistration({
    pluginKey: "diff-plugin",
    name: "Diff Plugin",
    version: "1.0.0",
    url: "http://diff-plugin:3000",
    manifestJson: "{}",
    tokenHash: "h",
  });
}

function createCalls(bot: Client, guildId: string): number {
  const g = (bot.guilds.cache as Map<string, { commands: { create: ReturnType<typeof vi.fn> } }>).get(guildId);
  return g ? g.commands.create.mock.calls.length : 0;
}

beforeAll(async () => {
  await sequelize.sync({ force: true });
});

beforeEach(async () => {
  await Plugin.destroy({ where: {} });
  await PluginCommand.destroy({ where: {} });
});

describe("diff-based sync (PM-7.3)", () => {
  it("first sync creates every command; identical re-sync creates none", async () => {
    const bot = makeFakeBot(["g1"]);
    setPluginCommandBotClient(bot);
    const row = await makePluginRow();
    const manifest = makeManifest([
      { name: "m-play", description: "play" },
      { name: "m-stop", description: "stop" },
    ]);

    await pluginCommandRegistry.sync(row, manifest);
    expect(createCalls(bot, "g1")).toBe(2);

    // Re-register with the SAME manifest → zero Discord writes.
    await pluginCommandRegistry.sync(row, manifest);
    expect(createCalls(bot, "g1")).toBe(2);

    const rows = await PluginCommand.findAll({ where: { pluginId: row.id } });
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.getDataValue("discordCommandId")).toBeTruthy();
    }
  });

  it("a changed command re-creates only that command", async () => {
    const bot = makeFakeBot(["g1"]);
    setPluginCommandBotClient(bot);
    const row = await makePluginRow();
    await pluginCommandRegistry.sync(
      row,
      makeManifest([
        { name: "m-play", description: "play" },
        { name: "m-stop", description: "stop" },
      ]),
    );
    expect(createCalls(bot, "g1")).toBe(2);

    await pluginCommandRegistry.sync(
      row,
      makeManifest([
        { name: "m-play", description: "play a song from the library" },
        { name: "m-stop", description: "stop" },
      ]),
    );
    expect(createCalls(bot, "g1")).toBe(3); // only m-play again
  });

  it("a removed command is deleted from Discord and the DB", async () => {
    const bot = makeFakeBot(["g1"]);
    setPluginCommandBotClient(bot);
    const row = await makePluginRow();
    await pluginCommandRegistry.sync(
      row,
      makeManifest([
        { name: "m-play", description: "play" },
        { name: "m-stop", description: "stop" },
      ]),
    );
    await pluginCommandRegistry.sync(
      row,
      makeManifest([{ name: "m-play", description: "play" }]),
    );
    const g1 = (bot.guilds.cache as Map<string, { commands: { delete: ReturnType<typeof vi.fn> } }>).get("g1")!;
    expect(g1.commands.delete).toHaveBeenCalledTimes(1);
    const rows = await PluginCommand.findAll({ where: { pluginId: row.id } });
    expect(rows.map((r) => r.getDataValue("name"))).toEqual(["m-play"]);
  });

  it("force: true rewrites even unchanged commands", async () => {
    const bot = makeFakeBot(["g1"]);
    setPluginCommandBotClient(bot);
    const row = await makePluginRow();
    const manifest = makeManifest([{ name: "m-play", description: "play" }]);
    await pluginCommandRegistry.sync(row, manifest);
    await pluginCommandRegistry.sync(row, manifest, { force: true });
    expect(createCalls(bot, "g1")).toBe(2);
  });

  it("propagates a Discord rate limit as CommandSyncRateLimitedError", async () => {
    const bot = makeFakeBot(["g1"]);
    const g1 = (bot.guilds.cache as Map<string, { commands: { create: ReturnType<typeof vi.fn> } }>).get("g1")!;
    g1.commands.create.mockRejectedValue(
      new RateLimitError({
        timeToReset: 42_000,
        limit: 0,
        method: "POST",
        hash: "h",
        url: "https://discord.com/api/v10/applications/1/guilds/g1/commands",
        route: "/applications/:id/guilds/:guildId/commands",
        majorParameter: "g1",
        global: false,
        retryAfter: 42_000,
        sublimitTimeout: 0,
        scope: "user",
      }),
    );
    setPluginCommandBotClient(bot);
    const row = await makePluginRow();
    await expect(
      pluginCommandRegistry.sync(
        row,
        makeManifest([{ name: "m-play", description: "play" }]),
      ),
    ).rejects.toMatchObject({
      name: "CommandSyncRateLimitedError",
      retryAfterMs: 42_000,
    });
    expect(
      (await PluginCommand.findAll({ where: { pluginId: row.id } })).length,
    ).toBe(0);
  });
});

describe("rate-limited state in background runner (PM-7.3)", () => {
  it("CommandSyncRateLimitedError carries retryAfterMs for the runner", () => {
    const err = new CommandSyncRateLimitedError(60_000);
    expect(err.retryAfterMs).toBe(60_000);
    expect(err.name).toBe("CommandSyncRateLimitedError");
  });
});

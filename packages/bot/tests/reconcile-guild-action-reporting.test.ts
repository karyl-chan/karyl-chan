/**
 * Regression: command reconciler reporting accuracy.
 *
 *  - Fix 1: applyOne's guild-scope branch used to return action:"noop"
 *    on every success, so reconcileAll's created/patched totals never
 *    counted guild-scope work (always 0) and the resync endpoint
 *    mislabelled every guild command as a no-op.
 *  - Fix 2: reconcileAll counted created/patched off result.action
 *    without checking result.ok, so a failed Discord create/patch was
 *    tallied as a success AND pushed to errors (double-counted).
 */

import { vi, describe, it, expect, beforeAll, beforeEach } from "vitest";

vi.hoisted(() => {
  process.env.SQLITE_DB_PATH = ":memory:";
  process.env.ENCRYPTION_KEY = "a".repeat(64);
});

import type { Client } from "discord.js";
import { sequelize } from "../src/db.js";
import { Behavior } from "../src/modules/behavior/models/behavior.model.js";
import { PluginCommand } from "../src/modules/plugin-system/models/plugin-command.model.js";
import { CommandReconciler } from "../src/modules/command-system/reconcile.service.js";
import { encryptSecret } from "../src/utils/crypto.js";

function makeCommands(create?: ReturnType<typeof vi.fn>) {
  return {
    // Empty Discord state → applyOne takes the create path.
    fetch: vi.fn(async () => new Map()),
    create: create ?? vi.fn(async () => ({ id: "new", name: "x" })),
    edit: vi.fn(async () => ({ id: "edited", name: "x" })),
    delete: vi.fn(async () => undefined),
  };
}

function makeClient(
  appCommands: ReturnType<typeof makeCommands>,
  guildCommands: ReturnType<typeof makeCommands>,
): Client {
  const guild = { id: "g1", commands: guildCommands };
  return {
    application: { commands: appCommands },
    guilds: { cache: new Map([["g1", guild]]) },
  } as unknown as Client;
}

async function seedGuildBehavior(): Promise<number> {
  await Behavior.create({
    id: 1,
    title: "ping",
    enabled: true,
    sortOrder: 0,
    source: "custom",
    triggerType: "slash_command",
    slashCommandName: "ping",
    slashCommandDescription: "ping",
    scope: "guild",
    integrationTypes: "guild_install",
    contexts: "Guild",
    audienceKind: "all",
    webhookUrl: encryptSecret("http://example.invalid/hook"),
    scopeTabId: 1,
  } as Record<string, unknown>);
  return 1;
}

beforeAll(async () => {
  await sequelize.sync({ force: true });
});

beforeEach(async () => {
  await Behavior.destroy({ where: {} });
  await PluginCommand.destroy({ where: {} });
});

describe("reconcile guild-scope action reporting", () => {
  it("reconcileForBehavior reports action=create for a guild-scope create (not noop)", async () => {
    const id = await seedGuildBehavior();
    const guildCmds = makeCommands();
    const reconciler = new CommandReconciler(() =>
      makeClient(makeCommands(), guildCmds),
    );

    const result = await reconciler.reconcileForBehavior(id);

    expect(result.ok).toBe(true);
    // Pre-fix this was "noop" even though a command was created.
    expect(result.action).toBe("create");
    expect(guildCmds.create).toHaveBeenCalledTimes(1);
  });

  it("reconcileAll counts guild-scope creates in report.created", async () => {
    await seedGuildBehavior();
    const guildCmds = makeCommands();
    const reconciler = new CommandReconciler(() =>
      makeClient(makeCommands(), guildCmds),
    );

    const report = await reconciler.reconcileAll();

    // Pre-fix: 0 (guild work returned noop). Post-fix: 1.
    expect(report.created).toBe(1);
    expect(report.errors).toHaveLength(0);
    expect(guildCmds.create).toHaveBeenCalledTimes(1);
  });

  it("reconcileAll does not count a failed create as created (Fix 2)", async () => {
    // A global-scope behavior whose Discord create throws.
    await Behavior.create({
      id: 2,
      title: "boom",
      enabled: true,
      sortOrder: 0,
      source: "custom",
      triggerType: "slash_command",
      slashCommandName: "boom",
      slashCommandDescription: "boom",
      scope: "global",
      integrationTypes: "guild_install",
      contexts: "BotDM",
      audienceKind: "all",
      webhookUrl: encryptSecret("http://example.invalid/hook"),
      scopeTabId: 1,
    } as Record<string, unknown>);

    const throwingCreate = vi.fn(async () => {
      throw new Error("Discord 500");
    });
    const appCmds = makeCommands(throwingCreate);
    const reconciler = new CommandReconciler(() =>
      makeClient(appCmds, makeCommands()),
    );

    const report = await reconciler.reconcileAll();

    // Pre-fix: created=1 (action was "create") AND errors=1 → double count.
    expect(report.created).toBe(0);
    expect(report.errors).toHaveLength(1);
  });
});

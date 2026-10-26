/**
 * Regression: the incremental reconcile paths (reconcileForBehaviorCommand /
 * reconcileForPluginCommand — used by /resync and the plugin adminEnabled
 * toggle) created the Discord command but never registered it in the
 * reconciler_owned_commands roster. A later reconcileAll keys its stale
 * sweep off that roster, so a command first created incrementally and
 * then orphaned (behavior deleted) was invisible to cleanup and lingered
 * on Discord forever. The fix registers the item after applyOne.
 */

import { vi, describe, it, expect, beforeAll, beforeEach } from "vitest";

vi.hoisted(() => {
  process.env.SQLITE_DB_PATH = ":memory:";
  process.env.ENCRYPTION_KEY = "a".repeat(64);
});

import type { Client } from "discord.js";
import { sequelize } from "../src/db.js";
import { BehaviorCommand } from "../src/modules/behavior/models/behavior-command.model.js";
import { PluginCommand } from "../src/modules/plugin-system/models/plugin-command.model.js";
import { ReconcilerOwnedCommand } from "../src/modules/command-system/models/reconciler-owned-command.model.js";
import { CommandReconciler } from "../src/modules/command-system/reconcile.service.js";
import { clearBehaviors, seedCommand, seedLeaf } from "./behavior-fixtures.js";

interface CmdStub {
  id: string;
  name: string;
  contexts?: number[];
}

/** discord.js returns a Collection (Map + `.find`); deleteStale relies on
 *  `.find`, so a plain Map mock would silently throw. */
class FakeCollection extends Map<string, CmdStub> {
  find(fn: (v: CmdStub) => boolean): CmdStub | undefined {
    for (const v of this.values()) if (fn(v)) return v;
    return undefined;
  }
}

/** Stateful command manager: create stores, fetch returns the store,
 *  delete removes — so create→fetch→delete reflects Discord reality. */
function statefulCommands() {
  const store = new Map<string, CmdStub>();
  let idc = 0;
  return {
    store,
    fetch: vi.fn(async () => new FakeCollection(store)),
    create: vi.fn(async (data: { name: string; contexts?: number[] }) => {
      const id = `c${++idc}`;
      const cmd: CmdStub = { id, name: data.name, contexts: data.contexts };
      store.set(id, cmd);
      return cmd;
    }),
    edit: vi.fn(async (id: string, data: { name: string }) => {
      const cmd: CmdStub = { id, name: data.name };
      store.set(id, cmd);
      return cmd;
    }),
    delete: vi.fn(async (id: string) => {
      store.delete(id);
    }),
  };
}

function makeClient(
  app: ReturnType<typeof statefulCommands>,
  guild: ReturnType<typeof statefulCommands>,
): Client {
  return {
    application: { commands: app },
    guilds: { cache: new Map([["g1", { id: "g1", commands: guild }]]) },
  } as unknown as Client;
}

async function seedGuildBehavior(): Promise<number> {
  const id = await seedCommand({ name: "ping", description: "ping", registration: "guild", guildId: "g1" });
  await seedLeaf(id, { title: "ping" });
  return id;
}

beforeAll(async () => {
  await sequelize.sync({ force: true });
});

beforeEach(async () => {
  await clearBehaviors();
  await PluginCommand.destroy({ where: {} });
  await ReconcilerOwnedCommand.destroy({ where: {} });
});

describe("reconcile incremental → owned-commands roster", () => {
  it("reconcileForBehaviorCommand registers the created command in the roster", async () => {
    const id = await seedGuildBehavior();
    const guildCmds = statefulCommands();
    const reconciler = new CommandReconciler(() =>
      makeClient(statefulCommands(), guildCmds),
    );

    await reconciler.reconcileForBehaviorCommand(id);

    // Pre-fix: 0 (incremental path never touched the roster).
    const rows = await ReconcilerOwnedCommand.findAll({
      where: { name: "ping", scope: "guild", guildId: "g1" },
    });
    expect(rows).toHaveLength(1);
  });

  it("a command created via reconcileForBehaviorCommand is cleaned up (not orphaned) by a later reconcileAll after the behavior is deleted", async () => {
    const id = await seedGuildBehavior();
    const guildCmds = statefulCommands();
    const appCmds = statefulCommands();
    const reconciler = new CommandReconciler(() => makeClient(appCmds, guildCmds));

    // 1. Incremental resync creates the guild command.
    await reconciler.reconcileForBehaviorCommand(id);
    expect(guildCmds.create).toHaveBeenCalledTimes(1);
    expect(guildCmds.store.size).toBe(1);

    // 2. The command is deleted — it is no longer desired.
    await BehaviorCommand.destroy({ where: { id } });

    // 3. Full reconcile must recognise the now-stale command and remove it.
    await reconciler.reconcileAll();

    // Pre-fix: roster empty → stale sweep can't find it → delete never
    // called → command orphaned (store still holds it).
    expect(guildCmds.delete).toHaveBeenCalledTimes(1);
    expect(guildCmds.store.size).toBe(0);
  });
});

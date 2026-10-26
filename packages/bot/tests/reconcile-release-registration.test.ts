/**
 * #136 — CommandReconciler.releaseRegistration(name, target): after a
 * behavior command is renamed, moved to another registration target or
 * deleted, its old registration is removed from Discord and the roster
 * right away — unless something still desired covers that name + target.
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
import { BehaviorCommand } from "../src/modules/behavior/models/behavior-command.model.js";
import { BehaviorDefinition } from "../src/modules/behavior/models/behavior-definition.model.js";
import { ReconcilerOwnedCommand } from "../src/modules/command-system/models/reconciler-owned-command.model.js";
import { CommandReconciler } from "../src/modules/command-system/reconcile.service.js";
import { clearBehaviors, seedCommand, seedLeaf } from "./behavior-fixtures.js";

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

function statefulCommands() {
  const store = new Map<string, CmdStub>();
  let idc = 0;
  return {
    store,
    names: () => [...store.values()].map((c) => c.name).sort(),
    fetch: vi.fn(async () => new FakeCollection(store)),
    create: vi.fn(async (data: { name: string }) => {
      const cmd = { id: `c${++idc}`, name: data.name };
      store.set(cmd.id, cmd);
      return cmd;
    }),
    edit: vi.fn(async (id: string, data: { name: string }) => {
      store.set(id, { id, name: data.name });
      return store.get(id);
    }),
    delete: vi.fn(async (id: string) => {
      store.delete(id);
    }),
  };
}

const app = statefulCommands();
const guild = statefulCommands();
const reconciler = new CommandReconciler(
  () =>
    ({
      application: { commands: app },
      guilds: { cache: new Map([["g1", { id: "g1", commands: guild }]]) },
    }) as unknown as Client,
);

beforeAll(async () => {
  await sequelize.sync({ force: true });
});

beforeEach(async () => {
  await clearBehaviors();
  await ReconcilerOwnedCommand.destroy({ where: {} });
  app.store.clear();
  guild.store.clear();
});

async function guildCommand(name: string): Promise<number> {
  const id = await seedCommand({ name, description: name, registration: "guild", guildId: "g1" });
  await seedLeaf(id, { title: name });
  return id;
}

describe("CommandReconciler.releaseRegistration", () => {
  it("removes a renamed command's old registration", async () => {
    const id = await guildCommand("old");
    await reconciler.registerOne({ source: "behavior", id });
    await BehaviorCommand.update({ name: "new" }, { where: { id } });
    await reconciler.registerOne({ source: "behavior", id });
    expect(guild.names()).toEqual(["new", "old"]);

    expect(await reconciler.releaseRegistration("old", "guild:g1")).toBe("removed");
    expect(guild.names()).toEqual(["new"]);
    expect(
      await ReconcilerOwnedCommand.count({ where: { name: "old", scope: "guild", guildId: "g1" } }),
    ).toBe(0);
  });

  it("removes a deleted command's registration", async () => {
    const id = await guildCommand("gone");
    await reconciler.registerOne({ source: "behavior", id });
    await BehaviorCommand.destroy({ where: { id } });
    expect(await reconciler.releaseRegistration("gone", "guild:g1")).toBe("removed");
    expect(guild.names()).toEqual([]);
  });

  it("keeps a registration something still desires", async () => {
    const id = await guildCommand("kept");
    await reconciler.registerOne({ source: "behavior", id });
    expect(await reconciler.releaseRegistration("kept", "guild:g1")).toBe("still_desired");
    expect(guild.names()).toEqual(["kept"]);
  });

  it("reconcileForBehaviorCommand reports a removal Discord refused", async () => {
    const id = await guildCommand("off");
    await reconciler.registerOne({ source: "behavior", id });
    await BehaviorDefinition.update({ enabled: false }, { where: { commandId: id } });
    guild.delete.mockRejectedValueOnce(new Error("Missing Access"));

    const result = await reconciler.reconcileForBehaviorCommand(id);
    expect(result).toMatchObject({ ok: false, action: "delete" });
    expect(result.error).toContain("Missing Access");
    expect(guild.names()).toEqual(["off"]);
  });

  it("reconcileForBehaviorCommand removes a command with no enabled leaf", async () => {
    const id = await guildCommand("off");
    await reconciler.registerOne({ source: "behavior", id });
    await BehaviorDefinition.update({ enabled: false }, { where: { commandId: id } });
    expect(await reconciler.reconcileForBehaviorCommand(id)).toMatchObject({
      ok: true,
      action: "delete",
    });
    expect(guild.names()).toEqual([]);
  });

  it("reconcileForBehaviorCommand reports a target it could not reach as skipped", async () => {
    const id = await seedCommand({
      name: "away",
      description: "away",
      registration: "guild",
      guildId: "elsewhere",
    });
    await seedLeaf(id, { title: "away", enabled: false });
    expect(await reconciler.reconcileForBehaviorCommand(id)).toMatchObject({
      ok: true,
      action: "delete",
      targets: [{ target: "guild:elsewhere", status: "skipped", reason: "guild_unavailable" }],
    });
  });

  it("reports a target the bot cannot reach", async () => {
    expect(await reconciler.releaseRegistration("x", "guild:elsewhere")).toBe("unavailable");
  });
});

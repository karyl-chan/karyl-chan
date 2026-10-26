/**
 * S2 (#133)：reconciler 以「註冊目標」（global / guild:<id> / all_guilds）
 * 表達指令要註冊到哪裡，過期清除以「名稱 + 目標」為鍵。
 *
 *  - #128：placement 是指定伺服器的 behavior（specific_guild /
 *    specific_channel 分頁）只註冊在那個伺服器，不再註冊到每個伺服器。
 *  - 過期清除不再丟掉 guildId：指令從某個伺服器移走時，那個伺服器的
 *    舊註冊會被清掉。
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
import { Behavior } from "../src/modules/behavior/models/behavior.model.js";
import { PluginCommand } from "../src/modules/plugin-system/models/plugin-command.model.js";
import { ReconcilerOwnedCommand } from "../src/modules/command-system/models/reconciler-owned-command.model.js";
import { CommandReconciler } from "../src/modules/command-system/reconcile.service.js";
import { encryptSecret } from "../src/utils/crypto.js";

interface CmdStub {
  id: string;
  name: string;
  description?: string;
  contexts?: number[];
  integrationTypes?: number[];
  options?: unknown[];
  defaultMemberPermissions?: { bitfield: bigint } | null;
}

class FakeCollection extends Map<string, CmdStub> {
  find(fn: (v: CmdStub) => boolean): CmdStub | undefined {
    for (const v of this.values()) if (fn(v)) return v;
    return undefined;
  }
}

/** 模擬 Discord：create 會存、fetch 回傳現況、edit 覆寫、delete 移除。 */
function statefulCommands() {
  const store = new Map<string, CmdStub>();
  let idc = 0;
  const toStub = (id: string, data: Record<string, unknown>): CmdStub => {
    const perms = data["defaultMemberPermissions"];
    return {
      id,
      name: data["name"] as string,
      description: data["description"] as string,
      contexts: data["contexts"] as number[] | undefined,
      integrationTypes: data["integrationTypes"] as number[] | undefined,
      options: data["options"] as unknown[] | undefined,
      defaultMemberPermissions:
        perms === undefined || perms === null
          ? null
          : { bitfield: BigInt(perms as string) },
    };
  };
  return {
    store,
    names: () => [...store.values()].map((c) => c.name).sort(),
    fetch: vi.fn(async () => new FakeCollection(store)),
    create: vi.fn(async (data: Record<string, unknown>) => {
      const id = `c${++idc}`;
      const cmd = toStub(id, data);
      store.set(id, cmd);
      return cmd;
    }),
    edit: vi.fn(async (id: string, data: Record<string, unknown>) => {
      const cmd = toStub(id, data);
      store.set(id, cmd);
      return cmd;
    }),
    delete: vi.fn(async (id: string) => {
      store.delete(id);
    }),
  };
}

type Cmds = ReturnType<typeof statefulCommands>;

function makeWorld(guildIds: string[]) {
  const app = statefulCommands();
  const guilds = new Map<string, Cmds>();
  for (const g of guildIds) guilds.set(g, statefulCommands());
  const client = {
    application: { commands: app },
    guilds: {
      cache: new Map(
        [...guilds.entries()].map(([id, commands]) => [id, { id, commands }]),
      ),
    },
  } as unknown as Client;
  return { app, guilds, client };
}

let nextId = 1;

async function seedSlashBehavior(
  overrides: Record<string, unknown> = {},
): Promise<number> {
  const id = nextId++;
  await Behavior.create({
    id,
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
    ...overrides,
  } as Record<string, unknown>);
  return id;
}

beforeAll(async () => {
  await sequelize.sync({ force: true });
});

beforeEach(async () => {
  await Behavior.destroy({ where: {} });
  await PluginCommand.destroy({ where: {} });
  await ReconcilerOwnedCommand.destroy({ where: {} });
});

describe("reconcile — registration targets", () => {
  it("a specific-guild behavior registers only in that guild (#128)", async () => {
    await seedSlashBehavior({ placementGuildId: "g1" });
    const world = makeWorld(["g1", "g2"]);
    const reconciler = new CommandReconciler(() => world.client);

    const report = await reconciler.reconcileAll();

    expect(report.errors).toEqual([]);
    expect(world.guilds.get("g1")!.names()).toEqual(["ping"]);
    expect(world.guilds.get("g2")!.names()).toEqual([]);
    expect(world.app.names()).toEqual([]);
  });

  it("an all-guilds behavior still registers in every guild", async () => {
    await seedSlashBehavior();
    const world = makeWorld(["g1", "g2"]);
    const reconciler = new CommandReconciler(() => world.client);

    await reconciler.reconcileAll();

    expect(world.guilds.get("g1")!.names()).toEqual(["ping"]);
    expect(world.guilds.get("g2")!.names()).toEqual(["ping"]);
  });

  it("a track-3 plugin command with scope=guild is registered in every guild (all_guilds)", async () => {
    const { Plugin } = await import(
      "../src/modules/plugin-system/models/plugin.model.js"
    );
    await Plugin.destroy({ where: {} });
    const plugin = await Plugin.create({
      pluginKey: "p1",
      name: "p1",
      version: "1.0.0",
      url: "http://p1.invalid",
      enabled: true,
      status: "active",
      manifestJson: JSON.stringify({ schema_version: "1" }),
    } as Record<string, unknown>);
    await PluginCommand.create({
      pluginId: plugin.getDataValue("id"),
      guildId: null,
      name: "radio",
      featureKey: null,
      manifestJson: JSON.stringify({
        name: "radio",
        description: "radio",
        scope: "guild",
        integration_types: ["guild_install"],
        contexts: ["Guild"],
      }),
    } as Record<string, unknown>);
    const world = makeWorld(["g1", "g2"]);
    const reconciler = new CommandReconciler(() => world.client);

    await reconciler.reconcileAll();

    expect(world.guilds.get("g1")!.names()).toEqual(["radio"]);
    expect(world.guilds.get("g2")!.names()).toEqual(["radio"]);
    expect(world.app.names()).toEqual([]);
  });

  it("a track-3 plugin command carries its manifest default_member_permissions", async () => {
    const { Plugin } = await import(
      "../src/modules/plugin-system/models/plugin.model.js"
    );
    await Plugin.destroy({ where: {} });
    const plugin = await Plugin.create({
      pluginKey: "p2",
      name: "p2",
      version: "1.0.0",
      url: "http://p2.invalid",
      enabled: true,
      status: "active",
      manifestJson: JSON.stringify({ schema_version: "1" }),
    } as Record<string, unknown>);
    await PluginCommand.create({
      pluginId: plugin.getDataValue("id"),
      guildId: null,
      name: "admin-tool",
      featureKey: null,
      manifestJson: JSON.stringify({
        name: "admin-tool",
        description: "admin tool",
        scope: "global",
        integration_types: ["guild_install"],
        contexts: ["Guild"],
        default_member_permissions: "MANAGE_GUILD",
      }),
    } as Record<string, unknown>);
    const world = makeWorld(["g1"]);
    const reconciler = new CommandReconciler(() => world.client);

    await reconciler.reconcileAll();
    const [created] = [...world.app.store.values()];
    expect(created?.defaultMemberPermissions?.bitfield).toBe(32n);

    // 第二次 reconcile：Discord 現況已一致，不應再 patch
    await reconciler.reconcileAll();
    expect(world.app.edit).not.toHaveBeenCalled();
  });

  it("reconcileForGuild only registers commands whose target covers that guild", async () => {
    await seedSlashBehavior({ placementGuildId: "g1", slashCommandName: "one" });
    await seedSlashBehavior({ slashCommandName: "every" });
    const world = makeWorld(["g1", "g2"]);
    const reconciler = new CommandReconciler(() => world.client);
    const g2 = (
      world.client.guilds.cache as unknown as Map<string, unknown>
    ).get("g2");

    await reconciler.reconcileForGuild(g2 as never);

    expect(world.guilds.get("g2")!.names()).toEqual(["every"]);
    expect(world.guilds.get("g1")!.names()).toEqual([]);
  });
});

describe("reconcile — stale cleanup keyed by name + target", () => {
  it("moving a behavior from all guilds to one guild removes it from the other guilds", async () => {
    const id = await seedSlashBehavior();
    const world = makeWorld(["g1", "g2"]);
    const reconciler = new CommandReconciler(() => world.client);
    await reconciler.reconcileAll();
    expect(world.guilds.get("g2")!.names()).toEqual(["ping"]);

    const row = await Behavior.findByPk(id);
    await row!.update({ placementGuildId: "g1" });
    const report = await reconciler.reconcileAll();

    expect(world.guilds.get("g1")!.names()).toEqual(["ping"]);
    expect(world.guilds.get("g2")!.names()).toEqual([]);
    expect(report.deleted).toBe(1);
  });

  it("moving a specific-guild behavior to another guild deletes the old registration", async () => {
    const id = await seedSlashBehavior({ placementGuildId: "g1" });
    const world = makeWorld(["g1", "g2"]);
    const reconciler = new CommandReconciler(() => world.client);
    await reconciler.reconcileAll();

    const row = await Behavior.findByPk(id);
    await row!.update({ placementGuildId: "g2" });
    await reconciler.reconcileAll();

    expect(world.guilds.get("g1")!.names()).toEqual([]);
    expect(world.guilds.get("g2")!.names()).toEqual(["ping"]);
  });

  it("keeps an owned registration in a guild outside this process's cache while it is still desired there", async () => {
    await seedSlashBehavior({ placementGuildId: "g-other-shard" });
    await ReconcilerOwnedCommand.create({
      name: "ping",
      scope: "guild",
      guildId: "g-other-shard",
      ownedAt: new Date(),
    });
    const world = makeWorld(["g1"]);
    const reconciler = new CommandReconciler(() => world.client);

    const report = await reconciler.reconcileAll();

    expect(report.deleted).toBe(0);
    expect(report.errors).toEqual([]);
    const rows = await ReconcilerOwnedCommand.findAll({
      where: { name: "ping", guildId: "g-other-shard" },
    });
    expect(rows).toHaveLength(1);
  });

  it("leaves a no-longer-desired registration in an unreachable guild to the process that can see it", async () => {
    await ReconcilerOwnedCommand.create({
      name: "gone",
      scope: "guild",
      guildId: "g-other-shard",
      ownedAt: new Date(),
    });
    const world = makeWorld(["g1"]);
    const reconciler = new CommandReconciler(() => world.client);

    const report = await reconciler.reconcileAll();

    // 只刪名冊會讓另一個 shard 上的 Discord 指令永遠失去認領者
    expect(report.deleted).toBe(0);
    const rows = await ReconcilerOwnedCommand.findAll({
      where: { name: "gone", guildId: "g-other-shard" },
    });
    expect(rows).toHaveLength(1);
  });
  it("disabling a behavior whose guild is unreachable keeps its roster row for the process that can see it", async () => {
    const id = await seedSlashBehavior({
      enabled: false,
      placementGuildId: "g-other-shard",
    });
    await ReconcilerOwnedCommand.create({
      name: "ping",
      scope: "guild",
      guildId: "g-other-shard",
      ownedAt: new Date(),
    });
    const world = makeWorld(["g1"]);
    const reconciler = new CommandReconciler(() => world.client);

    await reconciler.reconcileForBehavior(id);

    const rows = await ReconcilerOwnedCommand.findAll({
      where: { name: "ping", guildId: "g-other-shard" },
    });
    expect(rows).toHaveLength(1);
  });
});

describe("reconcile — registerOne", () => {
  it("registers one desired command and reports each target", async () => {
    const id = await seedSlashBehavior({ placementGuildId: "g1" });
    const world = makeWorld(["g1", "g2"]);
    const reconciler = new CommandReconciler(() => world.client);

    const result = await reconciler.registerOne({ source: "behavior", id });

    expect(result).toEqual({
      ok: true,
      key: { source: "behavior", id },
      name: "ping",
      outcomes: [{ target: "guild:g1", status: "created" }],
    });
    expect(world.guilds.get("g1")!.names()).toEqual(["ping"]);
    expect(world.guilds.get("g2")!.fetch).not.toHaveBeenCalled();
    // 註冊進名冊，之後的 reconcileAll 才認得
    const rows = await ReconcilerOwnedCommand.findAll({
      where: { name: "ping", scope: "guild", guildId: "g1" },
    });
    expect(rows).toHaveLength(1);
  });

  it("reports unchanged when Discord already matches", async () => {
    const id = await seedSlashBehavior({ placementGuildId: "g1" });
    const world = makeWorld(["g1"]);
    const reconciler = new CommandReconciler(() => world.client);
    await reconciler.registerOne({ source: "behavior", id });

    const again = await reconciler.registerOne({ source: "behavior", id });

    expect(again.ok).toBe(true);
    expect(again.ok && again.outcomes).toEqual([
      { target: "guild:g1", status: "unchanged" },
    ]);
  });

  it("fails with registration_failed when Discord rejects the create", async () => {
    const id = await seedSlashBehavior({ placementGuildId: "g1" });
    const world = makeWorld(["g1"]);
    world.guilds.get("g1")!.create.mockRejectedValueOnce(new Error("Discord 500"));
    const reconciler = new CommandReconciler(() => world.client);

    const result = await reconciler.registerOne({ source: "behavior", id });

    expect(result).toMatchObject({
      ok: false,
      reason: "registration_failed",
      outcomes: [
        {
          target: "guild:g1",
          status: "failed",
          attempted: "create",
          error: "Discord 500",
        },
      ],
    });
  });

  it("fails when the target guild is not reachable", async () => {
    const id = await seedSlashBehavior({ placementGuildId: "g-gone" });
    const world = makeWorld(["g1"]);
    const reconciler = new CommandReconciler(() => world.client);

    const result = await reconciler.registerOne({ source: "behavior", id });

    expect(result).toMatchObject({
      ok: false,
      reason: "registration_failed",
      outcomes: [
        { target: "guild:g-gone", status: "skipped", reason: "guild_unavailable" },
      ],
    });
  });

  it("refuses a disabled behavior as not_desired and a missing one as not_found", async () => {
    const id = await seedSlashBehavior({ enabled: false });
    const world = makeWorld(["g1"]);
    const reconciler = new CommandReconciler(() => world.client);

    expect(
      await reconciler.registerOne({ source: "behavior", id }),
    ).toMatchObject({ ok: false, reason: "not_desired" });
    expect(
      await reconciler.registerOne({ source: "behavior", id: 9999 }),
    ).toMatchObject({ ok: false, reason: "not_found" });
    expect(world.guilds.get("g1")!.create).not.toHaveBeenCalled();
  });

  it("runs under the reconcile lock (a concurrent reconcileAll does not interleave)", async () => {
    const id = await seedSlashBehavior({ placementGuildId: "g1" });
    const world = makeWorld(["g1"]);
    const order: string[] = [];
    const g1 = world.guilds.get("g1")!;
    const origCreate = g1.create.getMockImplementation()!;
    g1.create.mockImplementation(async (data: Record<string, unknown>) => {
      order.push("create:start");
      await new Promise((r) => setTimeout(r, 10));
      const res = await origCreate(data);
      order.push("create:end");
      return res;
    });
    const origFetch = g1.fetch.getMockImplementation()!;
    g1.fetch.mockImplementation(async () => {
      order.push("fetch");
      return origFetch();
    });
    const reconciler = new CommandReconciler(() => world.client);

    await Promise.all([
      reconciler.registerOne({ source: "behavior", id }),
      reconciler.reconcileAll(),
    ]);

    // registerOne 的 create 完成後，reconcileAll 才開始拉 Discord 現況
    expect(order.slice(0, 4)).toEqual([
      "fetch",
      "create:start",
      "create:end",
      "fetch",
    ]);
    expect(g1.names()).toEqual(["ping"]);
  });
});

describe("reconcile — registerOne with nothing to register", () => {
  it("an all-guilds command with no reachable guild is not reported as effective", async () => {
    const id = await seedSlashBehavior();
    const world = makeWorld([]);
    const reconciler = new CommandReconciler(() => world.client);

    const result = await reconciler.registerOne({ source: "behavior", id });

    expect(result).toMatchObject({
      ok: false,
      reason: "registration_failed",
      outcomes: [],
    });
  });
});

/**
 * #139 — CommandReconciler.withRegistrationLock(fn): the system login's
 * trigger switch registers the new command BEFORE the DB says so, then
 * writes the DB, all inside one reconcile lock — so no reconcileAll can
 * sweep the fresh registration in between, and a failed DB write can take
 * it back off Discord.
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
import type { CatalogCommand } from "../src/modules/behavior/behavior-catalog.js";
import { ReconcilerOwnedCommand } from "../src/modules/command-system/models/reconciler-owned-command.model.js";
import { CommandReconciler } from "../src/modules/command-system/reconcile.service.js";
import { clearBehaviors, seedCommand, seedLeaf } from "./behavior-fixtures.js";

interface CmdStub {
  id: string;
  name: string;
  description?: string;
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
    create: vi.fn(async (data: { name: string; description: string }) => {
      const cmd = { id: `c${++idc}`, name: data.name, description: data.description };
      store.set(cmd.id, cmd);
      return cmd;
    }),
    edit: vi.fn(async (id: string, data: { name: string; description: string }) => {
      store.set(id, { id, name: data.name, description: data.description });
      return store.get(id);
    }),
    delete: vi.fn(async (id: string) => {
      store.delete(id);
    }),
  };
}

const app = statefulCommands();
const reconciler = new CommandReconciler(
  () =>
    ({
      application: { commands: app },
      guilds: { cache: new Map() },
    }) as unknown as Client,
);

/** A system login command as the switch would store it — but not stored. */
function loginCommand(name = "login"): CatalogCommand {
  const now = new Date();
  return {
    id: 0,
    name,
    description: "Get an admin login link",
    registration: "global",
    guildId: null,
    integrationTypes: "guild_install",
    contexts: "BotDM",
    defaultMemberPermissions: null,
    isSystem: true,
    updatedAt: now,
    leaves: [
      {
        id: 1,
        title: "login",
        description: "",
        enabled: true,
        sortOrder: -1000,
        systemKey: "admin-login",
        triggerKind: "command",
        actionSource: "builtin",
        commandId: 0,
        subcommandGroup: "",
        subcommand: "",
        leafDescription: null,
        options: null,
        surface: null,
        guildId: null,
        channelId: null,
        patternKind: null,
        patternValue: null,
        stopOnMatch: false,
        ignoreBots: true,
        audienceKind: "all",
        audienceUserId: null,
        audienceGroupName: null,
        updatedAt: now,
        webhook: null,
      },
    ],
  };
}

beforeAll(async () => {
  await sequelize.sync({ force: true });
});

beforeEach(async () => {
  await clearBehaviors();
  await ReconcilerOwnedCommand.destroy({ where: {} });
  app.store.clear();
});

describe("CommandReconciler.withRegistrationLock", () => {
  it("registers a behavior command as given, before any row exists", async () => {
    const result = await reconciler.withRegistrationLock((locked) =>
      locked.registerBehaviorCommand(loginCommand()),
    );
    expect(result).toMatchObject({
      ok: true,
      name: "login",
      outcomes: [{ target: "global", status: "created" }],
    });
    expect(app.names()).toEqual(["login"]);
    // on the roster, so a later reconcileAll owns (and can sweep) it
    expect(await ReconcilerOwnedCommand.count({ where: { name: "login" } })).toBe(1);
  });

  it("reports a registration Discord refused", async () => {
    app.create.mockRejectedValueOnce(new Error("Missing Access"));
    const result = await reconciler.withRegistrationLock((locked) =>
      locked.registerBehaviorCommand(loginCommand()),
    );
    expect(result).toMatchObject({ ok: false, reason: "registration_failed" });
    expect(app.names()).toEqual([]);
  });

  it("keeps a reconcileAll out until the whole section is done", async () => {
    const order: string[] = [];
    let sweep: Promise<unknown> | null = null;
    await reconciler.withRegistrationLock(async (locked) => {
      await locked.registerBehaviorCommand(loginCommand());
      // a full reconcile now would see no row for /login and sweep it
      sweep = reconciler.reconcileAll().then(() => order.push("reconcileAll"));
      await new Promise((r) => setTimeout(r, 10));
      // … the switch stores the command
      const id = await seedCommand({
        name: "login",
        description: "Get an admin login link",
        contexts: "BotDM",
        isSystem: true,
      });
      await seedLeaf(id, { systemKey: "admin-login", actionSource: "builtin", sortOrder: -1000 }, null);
      order.push("stored");
    });
    await sweep;
    expect(order).toEqual(["stored", "reconcileAll"]);
    expect(app.names()).toEqual(["login"]);
  });

  it("takes a registration the DB does not hold back off Discord", async () => {
    const outcome = await reconciler.withRegistrationLock(async (locked) => {
      await locked.registerBehaviorCommand(loginCommand());
      // the DB write failed: nothing desires /login
      return locked.releaseRegistration("login", "global");
    });
    expect(outcome).toBe("removed");
    expect(app.names()).toEqual([]);
    expect(await ReconcilerOwnedCommand.count({ where: { name: "login" } })).toBe(0);
  });
});

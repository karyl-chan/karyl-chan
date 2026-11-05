/**
 * Migration 011 (ADR 0003): behaviors move from `behaviors` +
 * `behavior_scope_tabs` to `behavior_commands` / `behavior_definitions` /
 * `behavior_webhook_actions`.
 *
 * Runs against a DB shaped like production before the upgrade, booted the
 * way the bot boots: the old tables exist, `sync()` creates the new ones,
 * then the migration runs.
 *
 * Runs on in-memory SQLite. Set TEST_PG_SCRATCH_URL to also run it on
 * Postgres — the database at that URL is WIPED (its public schema is
 * dropped), so point it at a throwaway database.
 */
import { vi, describe, it, expect, beforeAll } from "vitest";

vi.hoisted(() => {
  process.env.SQLITE_DB_PATH = ":memory:";
  process.env.NODE_ENV = "test";
  process.env.ENCRYPTION_KEY = "a".repeat(64);
  process.env.DB_URL = process.env.TEST_PG_SCRATCH_URL ?? "";
});

vi.mock("../src/modules/bot-events/bot-event-log.js", () => ({
  botEventLog: { record: vi.fn() },
}));

import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { QueryInterface } from "sequelize";
import { sequelize, dbDialect } from "../src/db.js";
import { botEventLog } from "../src/modules/bot-events/bot-event-log.js";
import { BehaviorCommand } from "../src/modules/behavior/models/behavior-command.model.js";
import { BehaviorDefinition } from "../src/modules/behavior/models/behavior-definition.model.js";
import { BehaviorWebhookAction } from "../src/modules/behavior/models/behavior-webhook-action.model.js";
import { BehaviorStat } from "../src/modules/behavior/models/behavior-stats.model.js";
import { BehaviorGroupMember } from "../src/modules/behavior/models/behavior-group-member.model.js";
import { AdminRole } from "../src/modules/admin/models/admin-role.model.js";
import { AdminRoleCapability } from "../src/modules/admin/models/admin-role-capability.model.js";
// Tables other migrations touch, so the fresh-DB run sees what a boot sees.
import "../src/modules/plugin-system/models/plugin.model.js";
import "../src/modules/plugin-system/models/plugin-config.model.js";
import { ensureSystemBehaviors } from "../src/modules/behavior/system-seed.service.js";
import { up } from "../src/migrations/011-behavior-trigger-action-tables.js";
import {
  createLegacyBehaviorTables,
  insertFixedScopeTabs,
  insertLegacyBehavior,
  insertLegacyScopeTab,
  insertLegacyStat,
} from "./legacy-behavior-schema.js";

const qi = (): QueryInterface => sequelize.getQueryInterface();
const runUp = () =>
  (up as (c: { context: QueryInterface }) => Promise<void>)({ context: qi() });

async function resetSchema(): Promise<void> {
  if (dbDialect === "postgres") {
    await sequelize.query("DROP SCHEMA public CASCADE");
    await sequelize.query("CREATE SCHEMA public");
  } else {
    await sequelize.drop();
    for (const t of ["behaviors", "behavior_scope_tabs", "behavior_stats"]) {
      await qi().dropTable(t).catch(() => undefined);
    }
  }
}

async function tables(): Promise<string[]> {
  return ((await qi().showAllTables()) as unknown[]).map((t) =>
    typeof t === "string" ? t : (t as { tableName: string }).tableName,
  );
}

async function definitionsWhere(where: Record<string, unknown>) {
  return BehaviorDefinition.findAll({ where, order: [["id", "ASC"]] });
}

const G1 = "1258392899486224425";
const C1 = "1258392899486224999";
const U1 = "900000000000000001";
const OPTIONS = JSON.stringify([
  { type: "string", name: "q", description: "query", required: true },
]);

describe("011 on a production-shaped DB", () => {
  beforeAll(async () => {
    await resetSchema();
    await createLegacyBehaviorTables(qi());
    await insertFixedScopeTabs(qi());
    await insertLegacyScopeTab(qi(), { id: 5, tabType: "specific_guild", guildId: G1 });
    await insertLegacyScopeTab(qi(), { id: 6, tabType: "specific_user", userId: U1 });
    await insertLegacyScopeTab(qi(), {
      id: 7,
      tabType: "specific_channel",
      guildId: G1,
      channelId: C1,
    });
    await insertLegacyScopeTab(qi(), { id: 8, tabType: "specific_group", groupName: "vip" });

    // The owner's only way in: DM `!login`.
    await insertLegacyBehavior(qi(), {
      id: 1,
      title: "發送登入連結",
      description: "system login",
      sortOrder: -1000,
      stopOnMatch: true,
      source: "system",
      triggerType: "message_pattern",
      messagePatternKind: "startswith",
      messagePatternValue: "!login",
      integrationTypes: "guild_install,user_install",
      contexts: "BotDM",
      systemKey: "admin-login",
      scopeTabId: 3,
    });
    // global_all message pattern: fired in bot DMs and in every guild
    await insertLegacyBehavior(qi(), {
      id: 2,
      title: "test",
      sortOrder: 1,
      source: "custom",
      triggerType: "message_pattern",
      messagePatternKind: "startswith",
      messagePatternValue: "!test",
      contexts: "BotDM,Guild,PrivateChannel",
      webhookUrl: "enc-url-2",
      webhookSecret: "enc-secret-2",
      webhookAuthMode: "hmac",
      scopeTabId: 1,
    });
    // specific_guild slash
    await insertLegacyBehavior(qi(), {
      id: 3,
      title: "probe",
      sortOrder: 2,
      source: "custom",
      triggerType: "slash_command",
      slashCommandName: "kc-s2-probe",
      slashCommandDescription: "S2 probe",
      slashCommandOptions: OPTIONS,
      scope: "guild",
      contexts: "Guild",
      placementGuildId: G1,
      webhookUrl: "enc-url-3",
      scopeTabId: 5,
    });
    // specific_user slash — Discord cannot limit a command to one user
    await insertLegacyBehavior(qi(), {
      id: 4,
      title: "user slash",
      source: "custom",
      triggerType: "slash_command",
      slashCommandName: "mine",
      contexts: "BotDM,PrivateChannel",
      integrationTypes: "guild_install,user_install",
      audienceKind: "user",
      audienceUserId: U1,
      webhookUrl: "enc-url-4",
      scopeTabId: 6,
    });
    // specific_user message pattern — bot DM with an audience
    await insertLegacyBehavior(qi(), {
      id: 5,
      title: "user pattern",
      sortOrder: 3,
      source: "custom",
      triggerType: "message_pattern",
      messagePatternKind: "regex",
      messagePatternValue: "^hi",
      contexts: "BotDM,PrivateChannel",
      audienceKind: "user",
      audienceUserId: U1,
      webhookUrl: "enc-url-5",
      scopeTabId: 6,
    });
    // specific_channel message pattern
    await insertLegacyBehavior(qi(), {
      id: 6,
      title: "channel pattern",
      sortOrder: 4,
      stopOnMatch: true,
      ignoreBots: false,
      source: "custom",
      triggerType: "message_pattern",
      messagePatternKind: "endswith",
      messagePatternValue: "?",
      scope: "guild",
      contexts: "Guild",
      placementGuildId: G1,
      placementChannelId: C1,
      webhookUrl: "enc-url-6",
      scopeTabId: 7,
    });
    // a pattern that could only match in group DMs — the bot never sees those
    await insertLegacyBehavior(qi(), {
      id: 7,
      title: "group dm pattern",
      source: "custom",
      triggerType: "message_pattern",
      messagePatternKind: "startswith",
      messagePatternValue: "!g",
      contexts: "PrivateChannel",
      webhookUrl: "enc-url-7",
    });
    // all_guilds slash → a global command usable in guilds
    await insertLegacyBehavior(qi(), {
      id: 8,
      title: "everywhere",
      source: "custom",
      triggerType: "slash_command",
      slashCommandName: "everywhere",
      slashCommandDescription: "in every guild",
      scope: "guild",
      contexts: "Guild",
      webhookUrl: "enc-url-8",
      scopeTabId: 4,
    });
    // global_all slash, disabled
    await insertLegacyBehavior(qi(), {
      id: 9,
      title: "app",
      enabled: false,
      source: "custom",
      triggerType: "slash_command",
      slashCommandName: "app",
      contexts: "BotDM,Guild,PrivateChannel",
      integrationTypes: "guild_install,user_install",
      webhookUrl: "enc-url-9",
      webhookSecret: "enc-secret-9",
      webhookAuthMode: "token",
    });
    // specific_channel / specific_group slashes cannot be expressed either
    await insertLegacyBehavior(qi(), {
      id: 10,
      title: "channel slash",
      source: "custom",
      triggerType: "slash_command",
      slashCommandName: "chan",
      scope: "guild",
      contexts: "Guild",
      placementGuildId: G1,
      placementChannelId: C1,
      webhookUrl: "enc-url-10",
      scopeTabId: 7,
    });
    await insertLegacyBehavior(qi(), {
      id: 11,
      title: "group slash",
      source: "custom",
      triggerType: "slash_command",
      slashCommandName: "grp",
      contexts: "BotDM,PrivateChannel",
      integrationTypes: "guild_install,user_install",
      audienceKind: "group",
      audienceGroupName: "vip",
      webhookUrl: "enc-url-11",
      scopeTabId: 8,
    });
    await insertLegacyStat(qi(), { behaviorId: 1, successCount: 7 });
    await insertLegacyStat(qi(), { behaviorId: 2, successCount: 2, failureCount: 1 });
    await insertLegacyStat(qi(), { behaviorId: 3, successCount: 3 });
    await insertLegacyStat(qi(), { behaviorId: 4, successCount: 4 });

    // Boot order: sync() creates the new tables, then migrations run.
    await sequelize.sync();
    await BehaviorGroupMember.create({ groupName: "vip", userId: U1 });
    await runUp();
  });

  it("copies the login system row exactly as a bot DM message trigger", async () => {
    const [login] = await definitionsWhere({ systemKey: "admin-login" });
    expect(login).toBeDefined();
    expect(login.get()).toMatchObject({
      title: "發送登入連結",
      description: "system login",
      enabled: true,
      sortOrder: -1000,
      triggerKind: "message",
      actionSource: "builtin",
      surface: "bot_dm",
      guildId: null,
      channelId: null,
      patternKind: "startswith",
      patternValue: "!login",
      stopOnMatch: true,
      audienceKind: "all",
      commandId: null,
    });
    expect(await BehaviorWebhookAction.findByPk(login.get("id") as number)).toBeNull();
  });

  it("splits a pattern that fired in bot DMs and guilds into two message triggers", async () => {
    const rows = await definitionsWhere({ patternValue: "!test" });
    expect(rows.map((r) => [r.get("surface"), r.get("guildId")])).toEqual([
      ["bot_dm", null],
      ["guild", null],
    ]);
    for (const r of rows) {
      const action = await BehaviorWebhookAction.findByPk(r.get("id") as number);
      expect(action?.get()).toMatchObject({
        url: "enc-url-2",
        secret: "enc-secret-2",
        authMode: "hmac",
      });
      expect(r.get("actionSource")).toBe("webhook");
    }
  });

  it("maps a specific_guild slash to a guild command with a root leaf", async () => {
    const cmd = await BehaviorCommand.findOne({ where: { name: "kc-s2-probe" } });
    expect(cmd?.get()).toMatchObject({
      description: "S2 probe",
      registration: "guild",
      guildId: G1,
      contexts: "Guild",
      integrationTypes: "guild_install",
      defaultMemberPermissions: null,
      isSystem: false,
    });
    const [leaf] = await definitionsWhere({ commandId: cmd!.get("id") });
    expect(leaf.get()).toMatchObject({
      title: "probe",
      triggerKind: "command",
      subcommandGroup: "",
      subcommand: "",
      leafDescription: "S2 probe",
      options: OPTIONS,
      actionSource: "webhook",
    });
    const action = await BehaviorWebhookAction.findByPk(leaf.get("id") as number);
    expect(action?.get()).toMatchObject({ url: "enc-url-3", secret: null, authMode: null });
  });

  it("keeps a bot DM pattern's audience", async () => {
    const [row] = await definitionsWhere({ patternValue: "^hi" });
    expect(row.get()).toMatchObject({
      surface: "bot_dm",
      patternKind: "regex",
      audienceKind: "user",
      audienceUserId: U1,
    });
  });

  it("maps a specific_channel pattern to a guild channel trigger", async () => {
    const [row] = await definitionsWhere({ patternValue: "?" });
    expect(row.get()).toMatchObject({
      surface: "guild",
      guildId: G1,
      channelId: C1,
      patternKind: "endswith",
      stopOnMatch: true,
      ignoreBots: false,
    });
  });

  it("maps an all_guilds slash to a global command usable in guilds", async () => {
    const cmd = await BehaviorCommand.findOne({ where: { name: "everywhere" } });
    expect(cmd?.get()).toMatchObject({
      registration: "global",
      guildId: null,
      contexts: "Guild",
      integrationTypes: "guild_install",
    });
  });

  it("keeps a disabled slash as a command with a disabled leaf", async () => {
    const cmd = await BehaviorCommand.findOne({ where: { name: "app" } });
    expect(cmd?.get()).toMatchObject({
      registration: "global",
      contexts: "BotDM,Guild,PrivateChannel",
      integrationTypes: "guild_install,user_install",
      description: "app",
    });
    const [leaf] = await definitionsWhere({ commandId: cmd!.get("id") });
    expect(leaf.get("enabled")).toBe(false);
    const action = await BehaviorWebhookAction.findByPk(leaf.get("id") as number);
    expect(action?.get()).toMatchObject({ secret: "enc-secret-9", authMode: "token" });
  });

  it("logs and drops the rows that cannot map", async () => {
    expect(await BehaviorCommand.findOne({ where: { name: "mine" } })).toBeNull();
    expect(await BehaviorCommand.findOne({ where: { name: "chan" } })).toBeNull();
    expect(await BehaviorCommand.findOne({ where: { name: "grp" } })).toBeNull();
    expect(await definitionsWhere({ patternValue: "!g" })).toHaveLength(0);

    const messages = (botEventLog.record as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => String(c[2]),
    );
    for (const id of [4, 7, 10, 11]) {
      expect(messages.some((m) => m.includes(`#${id}`) && m.includes("dropped"))).toBe(true);
    }
    // 8 definitions: login, !test ×2, probe, ^hi, ?, everywhere, app
    expect(await BehaviorDefinition.count()).toBe(8);
  });

  it("moves stats onto the new rows and drops those of dropped rows", async () => {
    const stats = await BehaviorStat.findAll();
    const byCount = new Map(stats.map((s) => [s.get("successCount"), s.get("behaviorId")]));
    expect([...byCount.keys()].sort()).toEqual([2, 3, 7]);
    const [login] = await definitionsWhere({ systemKey: "admin-login" });
    expect(byCount.get(7)).toBe(login.get("id"));
    const [testDm] = await definitionsWhere({ patternValue: "!test", surface: "bot_dm" });
    expect(byCount.get(2)).toBe(testDm.get("id"));
  });

  it("drops the old tables and keeps group members", async () => {
    const all = await tables();
    expect(all).not.toContain("behaviors");
    expect(all).not.toContain("behavior_scope_tabs");
    expect(all).toContain("behavior_stats");
    expect(await BehaviorGroupMember.count()).toBe(1);
  });

  it("points behavior_stats at behavior_definitions", async () => {
    const [row] = await definitionsWhere({ patternValue: "!test", surface: "bot_dm" });
    await row.destroy();
    expect(await BehaviorStat.findByPk(row.get("id") as number)).toBeNull();
  });

  it("creates the unique indexes", async () => {
    await expect(
      BehaviorCommand.create({
        name: "everywhere",
        description: "dup",
        registration: "global",
        guildId: null,
        integrationTypes: "guild_install",
        contexts: "Guild",
      }),
    ).rejects.toThrow();
    await expect(
      BehaviorDefinition.create({
        title: "dup login",
        triggerKind: "message",
        actionSource: "builtin",
        systemKey: "admin-login",
        surface: "bot_dm",
        patternKind: "startswith",
        patternValue: "!x",
      }),
    ).rejects.toThrow();
  });

  it("new rows get fresh ids after the copied ones (Postgres sequences moved)", async () => {
    const cmd = await BehaviorCommand.create({
      name: "fresh",
      description: "fresh",
      registration: "global",
      guildId: null,
      integrationTypes: "guild_install",
      contexts: "Guild",
    });
    const leaf = await BehaviorDefinition.create({
      title: "fresh",
      triggerKind: "command",
      actionSource: "webhook",
      commandId: cmd.get("id"),
      subcommandGroup: "",
      subcommand: "",
    });
    expect(cmd.get("id")).toBeGreaterThan(3);
    expect(leaf.get("id")).toBeGreaterThan(8);
  });

  it("the system seed finds the migrated login and adds nothing", async () => {
    const before = await BehaviorDefinition.count();
    const res = await ensureSystemBehaviors();
    expect(res).toEqual({ created: [], existing: ["admin-login"] });
    expect(await BehaviorDefinition.count()).toBe(before);
  });

  it("re-running is a no-op", async () => {
    const before = await BehaviorDefinition.count();
    await expect(runUp()).resolves.toBeUndefined();
    expect(await BehaviorDefinition.count()).toBe(before);
  });
});

describe("011 when the login was a slash command", () => {
  beforeAll(async () => {
    await resetSchema();
    await createLegacyBehaviorTables(qi());
    await insertFixedScopeTabs(qi());
    await insertLegacyBehavior(qi(), {
      id: 1,
      title: "發送登入連結",
      sortOrder: -1000,
      stopOnMatch: true,
      source: "system",
      triggerType: "slash_command",
      slashCommandName: "login",
      slashCommandDescription: "取得 admin 後台一次性登入連結",
      integrationTypes: "guild_install,user_install",
      contexts: "BotDM",
      systemKey: "admin-login",
      scopeTabId: 3,
    });
    await sequelize.sync();
    await runUp();
  });

  it("creates its system command and root leaf", async () => {
    const cmd = await BehaviorCommand.findOne({ where: { name: "login" } });
    expect(cmd?.get()).toMatchObject({
      isSystem: true,
      registration: "global",
      contexts: "BotDM",
      integrationTypes: "guild_install,user_install",
      description: "取得 admin 後台一次性登入連結",
    });
    const [leaf] = await definitionsWhere({ systemKey: "admin-login" });
    expect(leaf.get()).toMatchObject({
      commandId: cmd!.get("id"),
      triggerKind: "command",
      subcommand: "",
      actionSource: "builtin",
      enabled: true,
    });
  });
});

describe("011 when two old slash rows claim one command name", () => {
  beforeAll(async () => {
    await resetSchema();
    await createLegacyBehaviorTables(qi());
    await insertFixedScopeTabs(qi());
    const dup = {
      source: "custom",
      triggerType: "slash_command",
      slashCommandName: "dup",
      webhookUrl: "enc",
    };
    // the old unique index only covered enabled rows
    await insertLegacyBehavior(qi(), { id: 1, title: "old", sortOrder: 0, enabled: false, ...dup });
    await insertLegacyBehavior(qi(), { id: 2, title: "live", sortOrder: 1, ...dup });
    await sequelize.sync();
    (botEventLog.record as ReturnType<typeof vi.fn>).mockClear();
    await runUp();
  });

  it("keeps the enabled one and drops the other", async () => {
    const cmd = await BehaviorCommand.findOne({ where: { name: "dup" } });
    const leaves = await definitionsWhere({ commandId: cmd!.get("id") });
    expect(leaves.map((l) => [l.get("title"), l.get("enabled")])).toEqual([["live", true]]);
    const messages = (botEventLog.record as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[2]));
    expect(messages.some((m) => m.includes("#1 dropped") && m.includes("#2"))).toBe(true);
  });
});

describe("011 on a pattern for a user / group that also fired in guilds", () => {
  beforeAll(async () => {
    await resetSchema();
    await createLegacyBehaviorTables(qi());
    await insertFixedScopeTabs(qi());
    await insertLegacyBehavior(qi(), {
      id: 1,
      title: "vip pattern",
      source: "custom",
      triggerType: "message_pattern",
      messagePatternKind: "startswith",
      messagePatternValue: "!vip",
      contexts: "BotDM,Guild,PrivateChannel",
      audienceKind: "group",
      audienceGroupName: "vip",
      webhookUrl: "enc",
    });
    await sequelize.sync();
    (botEventLog.record as ReturnType<typeof vi.fn>).mockClear();
    await runUp();
  });

  it("keeps the bot DM half with its audience and drops only the guild half", async () => {
    const rows = await definitionsWhere({ patternValue: "!vip" });
    expect(rows.map((r) => [r.get("surface"), r.get("audienceKind"), r.get("audienceGroupName")])).toEqual([
      ["bot_dm", "group", "vip"],
    ]);
    const messages = (botEventLog.record as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[2]));
    expect(messages.some((m) => m.includes("#1 kept in bot DMs") && m.includes("guild trigger dropped"))).toBe(true);
  });
});

describe("011 and stored behavior:<scopeKey>.manage grants", () => {
  beforeAll(async () => {
    await resetSchema();
    await createLegacyBehaviorTables(qi());
    await insertFixedScopeTabs(qi());
    await sequelize.sync();
    await AdminRole.create({ name: "mod", description: "" } as Record<string, unknown>);
    for (const capability of [
      "behavior.manage",
      "behavior:guild:G1.manage",
      "behavior:global_all.manage",
      "guild.manage",
    ]) {
      await AdminRoleCapability.create({ role: "mod", capability });
    }
    (botEventLog.record as ReturnType<typeof vi.fn>).mockClear();
    await runUp();
  });

  it("removes the scoped tokens and keeps every other grant", async () => {
    const caps = await AdminRoleCapability.findAll({ where: { role: "mod" } });
    expect(caps.map((c) => c.get("capability")).sort()).toEqual([
      "behavior.manage",
      "guild.manage",
    ]);
    const messages = (botEventLog.record as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[2]));
    expect(messages.some((m) => m.includes("removed 2 behavior:<scopeKey>.manage"))).toBe(true);
  });
});

describe("011 when the move fails", () => {
  beforeAll(async () => {
    await resetSchema();
    await createLegacyBehaviorTables(qi());
    await insertFixedScopeTabs(qi());
    await insertLegacyBehavior(qi(), {
      id: 1,
      title: "hook",
      source: "custom",
      triggerType: "message_pattern",
      messagePatternKind: "startswith",
      messagePatternValue: "!h",
      contexts: "BotDM",
      webhookUrl: "enc",
    });
    // dropped by the mapping, so the run has a log entry before it fails
    await insertLegacyBehavior(qi(), {
      id: 2,
      title: "group dm only",
      source: "custom",
      triggerType: "message_pattern",
      messagePatternKind: "startswith",
      messagePatternValue: "!g",
      contexts: "PrivateChannel",
      webhookUrl: "enc",
    });
    await sequelize.sync();
    // the unique index on command names fails after the rows are moved
    for (const id of [101, 102]) {
      await BehaviorCommand.create({
        id,
        name: "clash",
        description: "clash",
        registration: "global",
        guildId: null,
        integrationTypes: "guild_install",
        contexts: "Guild",
      });
    }
    (botEventLog.record as ReturnType<typeof vi.fn>).mockClear();
  });

  it("rolls back and logs nothing", async () => {
    await expect(runUp()).rejects.toThrow();
    expect(botEventLog.record).not.toHaveBeenCalled();
    expect(await tables()).toContain("behaviors");
    expect(await BehaviorDefinition.count()).toBe(0);
    expect(await BehaviorCommand.count()).toBe(2);
  });
});

describe("011 on a fresh DB", () => {
  beforeAll(async () => {
    await resetSchema();
    await sequelize.sync();
  });

  it("every migration runs cleanly without the old tables", async () => {
    const dir = fileURLToPath(new URL("../src/migrations/", import.meta.url));
    const files = readdirSync(dir)
      .filter((f) => /^\d{3}-.*\.ts$/.test(f))
      .sort();
    expect(files.length).toBeGreaterThan(10);
    for (const file of files) {
      const mod = (await import(`../src/migrations/${file}`)) as {
        up: (c: { context: QueryInterface }) => Promise<void>;
      };
      await mod.up({ context: qi() });
    }
    const all = await tables();
    expect(all).not.toContain("behaviors");
    expect(all).toContain("behavior_definitions");
  });

  it("the system seed creates the default DM `!login` trigger once", async () => {
    expect(await ensureSystemBehaviors()).toEqual({
      created: ["admin-login"],
      existing: [],
    });
    const [login] = await definitionsWhere({ systemKey: "admin-login" });
    expect(login.get()).toMatchObject({
      triggerKind: "message",
      actionSource: "builtin",
      surface: "bot_dm",
      patternKind: "startswith",
      patternValue: "!login",
      enabled: true,
      stopOnMatch: true,
    });
    expect(await ensureSystemBehaviors()).toEqual({
      created: [],
      existing: ["admin-login"],
    });
  });
});

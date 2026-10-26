/**
 * The behaviors schema as it stood before migration 011 (ADR 0003 table
 * cutover): `behaviors`, `behavior_scope_tabs`, and `behavior_stats` with
 * its foreign key on `behaviors`. Frozen here because the models are gone;
 * migration tests build an "old database" from it.
 *
 * ENUM columns mirror the old model, so on Postgres the same
 * `enum_behaviors_*` types exist as on a long-lived production DB.
 */
import { DataTypes, type QueryInterface } from "sequelize";

const T = DataTypes;

export async function createLegacyBehaviorTables(
  qi: QueryInterface,
): Promise<void> {
  await qi.createTable("behavior_scope_tabs", {
    id: { type: T.INTEGER, autoIncrement: true, primaryKey: true },
    tabType: { type: T.STRING, allowNull: false },
    label: { type: T.TEXT, allowNull: false, defaultValue: "" },
    isFixed: { type: T.BOOLEAN, allowNull: false, defaultValue: false },
    guildId: { type: T.TEXT, allowNull: true },
    channelId: { type: T.TEXT, allowNull: true },
    userId: { type: T.TEXT, allowNull: true },
    groupName: { type: T.TEXT, allowNull: true },
    sortOrder: { type: T.INTEGER, allowNull: false, defaultValue: 0 },
    createdAt: { type: T.DATE, allowNull: false },
    updatedAt: { type: T.DATE, allowNull: false },
  });
  await qi.createTable("behaviors", {
    id: { type: T.INTEGER, autoIncrement: true, primaryKey: true },
    title: { type: T.TEXT, allowNull: false },
    description: { type: T.TEXT, allowNull: false, defaultValue: "" },
    enabled: { type: T.BOOLEAN, allowNull: false, defaultValue: true },
    sortOrder: { type: T.INTEGER, allowNull: false, defaultValue: 0 },
    stopOnMatch: { type: T.BOOLEAN, allowNull: false, defaultValue: false },
    ignoreBots: { type: T.BOOLEAN, allowNull: false, defaultValue: true },
    sessionExpireHours: { type: T.INTEGER, allowNull: true },
    forwardType: {
      type: T.ENUM("one_time", "continuous"),
      allowNull: false,
      defaultValue: "one_time",
    },
    source: { type: T.ENUM("custom", "system"), allowNull: false },
    triggerType: {
      type: T.ENUM("slash_command", "message_pattern"),
      allowNull: false,
    },
    messagePatternKind: {
      type: T.ENUM("startswith", "endswith", "regex"),
      allowNull: true,
    },
    messagePatternValue: { type: T.TEXT, allowNull: true },
    slashCommandName: { type: T.STRING, allowNull: true },
    slashCommandDescription: { type: T.TEXT, allowNull: true },
    slashCommandOptions: { type: T.TEXT, allowNull: true },
    scope: {
      type: T.ENUM("global", "guild"),
      allowNull: false,
      defaultValue: "global",
    },
    integrationTypes: {
      type: T.TEXT,
      allowNull: false,
      defaultValue: "guild_install",
    },
    contexts: { type: T.TEXT, allowNull: false, defaultValue: "Guild" },
    placementGuildId: { type: T.TEXT, allowNull: true },
    placementChannelId: { type: T.TEXT, allowNull: true },
    audienceKind: {
      type: T.ENUM("all", "user", "group"),
      allowNull: false,
      defaultValue: "all",
    },
    audienceUserId: { type: T.TEXT, allowNull: true },
    audienceGroupName: { type: T.TEXT, allowNull: true },
    webhookUrl: { type: T.TEXT, allowNull: true },
    webhookSecret: { type: T.TEXT, allowNull: true },
    webhookAuthMode: { type: T.ENUM("token", "hmac"), allowNull: true },
    systemKey: { type: T.ENUM("admin-login", "manual", "break"), allowNull: true },
    scopeTabId: { type: T.INTEGER, allowNull: false, defaultValue: 1 },
    createdAt: { type: T.DATE, allowNull: false },
    updatedAt: { type: T.DATE, allowNull: false },
  });
  await qi.addIndex("behaviors", {
    name: "behaviors_slash_uq",
    unique: true,
    fields: ["slashCommandName", "scope", "contexts"],
    where: { triggerType: "slash_command", enabled: true },
  });
  await qi.createTable("behavior_stats", {
    behaviorId: {
      type: T.INTEGER,
      primaryKey: true,
      references: { model: "behaviors", key: "id" },
      onDelete: "CASCADE",
      onUpdate: "CASCADE",
    },
    lastFiredAt: { type: T.STRING, allowNull: true },
    successCount: { type: T.INTEGER, allowNull: false, defaultValue: 0 },
    failureCount: { type: T.INTEGER, allowNull: false, defaultValue: 0 },
    consecutiveFailures: { type: T.INTEGER, allowNull: false, defaultValue: 0 },
    lastError: { type: T.TEXT, allowNull: true },
    lastErrorAt: { type: T.STRING, allowNull: true },
    createdAt: { type: T.DATE, allowNull: false },
    updatedAt: { type: T.DATE, allowNull: false },
  });
}

/** The four fixed tabs every production DB carries. */
export async function insertFixedScopeTabs(qi: QueryInterface): Promise<void> {
  const now = new Date();
  await qi.bulkInsert(
    "behavior_scope_tabs",
    ["global_all", "all_dms", "all_bot_dms", "all_guilds"].map((tabType, i) => ({
      id: i + 1,
      tabType,
      label: tabType,
      isFixed: true,
      sortOrder: i,
      createdAt: now,
      updatedAt: now,
    })),
  );
}

export async function insertLegacyScopeTab(
  qi: QueryInterface,
  row: Record<string, unknown>,
): Promise<void> {
  const now = new Date();
  await qi.bulkInsert("behavior_scope_tabs", [
    {
      label: "",
      isFixed: false,
      guildId: null,
      channelId: null,
      userId: null,
      groupName: null,
      sortOrder: 100,
      createdAt: now,
      updatedAt: now,
      ...row,
    },
  ]);
}

/** One `behaviors` row with the old model's defaults filled in. */
export async function insertLegacyBehavior(
  qi: QueryInterface,
  row: Record<string, unknown>,
): Promise<void> {
  const now = new Date();
  await qi.bulkInsert("behaviors", [
    {
      description: "",
      enabled: true,
      sortOrder: 0,
      stopOnMatch: false,
      ignoreBots: true,
      sessionExpireHours: null,
      forwardType: "one_time",
      messagePatternKind: null,
      messagePatternValue: null,
      slashCommandName: null,
      slashCommandDescription: null,
      slashCommandOptions: null,
      scope: "global",
      integrationTypes: "guild_install",
      contexts: "Guild",
      placementGuildId: null,
      placementChannelId: null,
      audienceKind: "all",
      audienceUserId: null,
      audienceGroupName: null,
      webhookUrl: null,
      webhookSecret: null,
      webhookAuthMode: null,
      systemKey: null,
      scopeTabId: 1,
      createdAt: now,
      updatedAt: now,
      ...row,
    },
  ]);
}

export async function insertLegacyStat(
  qi: QueryInterface,
  row: Record<string, unknown>,
): Promise<void> {
  const now = new Date();
  await qi.bulkInsert("behavior_stats", [
    {
      lastFiredAt: null,
      successCount: 0,
      failureCount: 0,
      consecutiveFailures: 0,
      lastError: null,
      lastErrorAt: null,
      createdAt: now,
      updatedAt: now,
      ...row,
    },
  ]);
}

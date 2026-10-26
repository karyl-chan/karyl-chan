/**
 * Migration 010 (ADR 0003): removes continuous sessions together with the
 * `manual` / `break` system behaviors, on a DB shaped like production
 * before the upgrade (three system rows, a session table).
 *
 *   1. manual / break rows and their stats are deleted; admin-login stays
 *      untouched (it is the owner's only way into the admin UI)
 *   2. continuous rows become one_time with no session TTL
 *   3. behavior_sessions is dropped
 *   4. re-running is a no-op
 */
import { vi, describe, it, expect, beforeAll } from "vitest";

vi.hoisted(() => {
  process.env.SQLITE_DB_PATH = ":memory:";
  process.env.NODE_ENV = "test";
});

import { DataTypes } from "sequelize";
import { sequelize } from "../src/db.js";
import { Behavior } from "../src/modules/behavior/models/behavior.model.js";
import { BehaviorStat } from "../src/modules/behavior/models/behavior-stats.model.js";
import { up } from "../src/migrations/010-remove-sessions-break-manual.js";

const qi = () => sequelize.getQueryInterface();
const runUp = () =>
  (up as (c: { context: unknown }) => Promise<void>)({ context: qi() });

const SYSTEM_BASE = {
  enabled: true,
  stopOnMatch: true,
  forwardType: "one_time",
  source: "system",
  triggerType: "message_pattern",
  messagePatternKind: "startswith",
  scope: "global",
  integrationTypes: "guild_install,user_install",
  contexts: "BotDM",
  audienceKind: "all",
  scopeTabId: 3,
} as const;

beforeAll(async () => {
  await sequelize.sync({ force: true });

  // Production shape before the upgrade. `manual` / `break` are no longer
  // valid systemKey values in the model, so skip model validation.
  await Behavior.create(
    { id: 1, title: "login", sortOrder: -1000, messagePatternValue: "!login", systemKey: "admin-login", ...SYSTEM_BASE },
    { validate: false },
  );
  await Behavior.create(
    { id: 2, title: "manual", sortOrder: -998, messagePatternValue: "!manual", systemKey: "manual", ...SYSTEM_BASE, enabled: false },
    { validate: false },
  );
  await Behavior.create(
    { id: 3, title: "break", sortOrder: -999, messagePatternValue: "!break", systemKey: "break", ...SYSTEM_BASE },
    { validate: false },
  );
  await Behavior.create({
    id: 4,
    title: "agent",
    enabled: true,
    sortOrder: 0,
    stopOnMatch: false,
    forwardType: "continuous",
    sessionExpireHours: 6,
    source: "custom",
    triggerType: "message_pattern",
    messagePatternKind: "startswith",
    messagePatternValue: "!agent",
    scope: "global",
    integrationTypes: "guild_install,user_install",
    contexts: "BotDM",
    audienceKind: "all",
    webhookUrl: "enc",
    scopeTabId: 1,
  } as Record<string, unknown>);
  await BehaviorStat.create({ behaviorId: 3, successCount: 1 } as Record<string, unknown>);
  await BehaviorStat.create({ behaviorId: 4, successCount: 2 } as Record<string, unknown>);

  await qi().createTable("behavior_sessions", {
    userId: { type: DataTypes.STRING, primaryKey: true },
    channelId: { type: DataTypes.STRING, primaryKey: true },
    behaviorId: { type: DataTypes.INTEGER, allowNull: false },
    startedAt: { type: DataTypes.STRING, allowNull: false },
    expiresAt: { type: DataTypes.STRING, allowNull: true },
    createdAt: { type: DataTypes.DATE, allowNull: false },
    updatedAt: { type: DataTypes.DATE, allowNull: false },
  });
  await qi().bulkInsert("behavior_sessions", [
    {
      userId: "U1",
      channelId: "DM-U1",
      behaviorId: 4,
      startedAt: new Date().toISOString(),
      expiresAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  ]);

  await runUp();
});

describe("010-remove-sessions-break-manual", () => {
  it("1. deletes manual/break and their stats, keeps admin-login as-is", async () => {
    const rows = await Behavior.findAll({ order: [["id", "ASC"]] });
    expect(rows.map((r) => r.getDataValue("id"))).toEqual([1, 4]);
    const login = rows[0];
    expect(login.getDataValue("systemKey")).toBe("admin-login");
    expect(login.getDataValue("messagePatternValue")).toBe("!login");
    expect(login.getDataValue("enabled")).toBe(true);
    const stats = await BehaviorStat.findAll();
    expect(stats.map((s) => s.getDataValue("behaviorId"))).toEqual([4]);
  });

  it("2. continuous rows become one_time with no session TTL", async () => {
    const agent = await Behavior.findByPk(4);
    expect(agent?.getDataValue("forwardType")).toBe("one_time");
    expect(agent?.getDataValue("sessionExpireHours")).toBeNull();
  });

  it("3. drops behavior_sessions", async () => {
    const tables = (await qi().showAllTables()) as string[];
    expect(tables).not.toContain("behavior_sessions");
  });

  it("4. re-running is a no-op", async () => {
    await expect(runUp()).resolves.toBeUndefined();
    expect(await Behavior.count()).toBe(2);
  });
});

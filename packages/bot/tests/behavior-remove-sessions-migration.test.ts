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

import { DataTypes, type QueryInterface } from "sequelize";
import { sequelize } from "../src/db.js";
import { up } from "../src/migrations/010-remove-sessions-break-manual.js";
import {
  createLegacyBehaviorTables,
  insertLegacyBehavior,
  insertLegacyStat,
} from "./legacy-behavior-schema.js";

const qi = (): QueryInterface => sequelize.getQueryInterface();
const runUp = () =>
  (up as (c: { context: unknown }) => Promise<void>)({ context: qi() });

type Row = Record<string, unknown>;
const select = async (table: string): Promise<Row[]> =>
  ((await qi().select(null, table)) as Row[]).sort(
    (a, b) => Number(a["id"] ?? a["behaviorId"]) - Number(b["id"] ?? b["behaviorId"]),
  );

const SYSTEM_BASE = {
  stopOnMatch: true,
  source: "system",
  triggerType: "message_pattern",
  messagePatternKind: "startswith",
  integrationTypes: "guild_install,user_install",
  contexts: "BotDM",
  scopeTabId: 3,
} as const;

beforeAll(async () => {
  await createLegacyBehaviorTables(qi());

  // Production shape before the upgrade.
  await insertLegacyBehavior(qi(), {
    id: 1, title: "login", sortOrder: -1000, messagePatternValue: "!login", systemKey: "admin-login", ...SYSTEM_BASE,
  });
  await insertLegacyBehavior(qi(), {
    id: 2, title: "manual", sortOrder: -998, messagePatternValue: "!manual", systemKey: "manual", ...SYSTEM_BASE, enabled: false,
  });
  await insertLegacyBehavior(qi(), {
    id: 3, title: "break", sortOrder: -999, messagePatternValue: "!break", systemKey: "break", ...SYSTEM_BASE,
  });
  await insertLegacyBehavior(qi(), {
    id: 4,
    title: "agent",
    forwardType: "continuous",
    sessionExpireHours: 6,
    source: "custom",
    triggerType: "message_pattern",
    messagePatternKind: "startswith",
    messagePatternValue: "!agent",
    integrationTypes: "guild_install,user_install",
    contexts: "BotDM",
    webhookUrl: "enc",
  });
  await insertLegacyStat(qi(), { behaviorId: 3, successCount: 1 });
  await insertLegacyStat(qi(), { behaviorId: 4, successCount: 2 });

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
    const rows = await select("behaviors");
    expect(rows.map((r) => r["id"])).toEqual([1, 4]);
    expect(rows[0]).toMatchObject({
      systemKey: "admin-login",
      messagePatternValue: "!login",
    });
    expect(Boolean(rows[0]["enabled"])).toBe(true);
    const stats = await select("behavior_stats");
    expect(stats.map((s) => s["behaviorId"])).toEqual([4]);
  });

  it("2. continuous rows become one_time with no session TTL", async () => {
    const agent = (await select("behaviors")).find((r) => r["id"] === 4);
    expect(agent?.["forwardType"]).toBe("one_time");
    expect(agent?.["sessionExpireHours"]).toBeNull();
  });

  it("3. drops behavior_sessions", async () => {
    const tables = (await qi().showAllTables()) as string[];
    expect(tables).not.toContain("behavior_sessions");
  });

  it("4. re-running is a no-op", async () => {
    await expect(runUp()).resolves.toBeUndefined();
    expect(await select("behaviors")).toHaveLength(2);
  });
});

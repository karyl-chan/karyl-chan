/**
 * BH-4.3 migration: 003-behavior-session-channel-pk rebuilds
 * behavior_sessions with PK (userId, channelId). Existing rows survive
 * the rebuild; fresh installs already have the shape from sync() so the
 * migration must no-op there. Coverage:
 *   1. legacy table (PK=userId) → up() rebuilds, rows preserved, and the
 *      new shape accepts two channels for the same user
 *   2. up() is idempotent on the already-migrated shape
 */
import { vi, describe, it, expect, beforeAll } from "vitest";

vi.hoisted(() => {
  process.env.SQLITE_DB_PATH = ":memory:";
  process.env.NODE_ENV = "test";
  process.env.ENCRYPTION_KEY = "a".repeat(64);
});

import { QueryTypes } from "sequelize";
import { sequelize } from "../src/db.js";
import { Behavior } from "../src/modules/behavior/models/behavior.model.js";
import { BehaviorSession } from "../src/modules/behavior/models/behavior-session.model.js";
import { up } from "../src/migrations/003-behavior-session-channel-pk.js";
import { encryptSecret } from "../src/utils/crypto.js";

const qi = () => sequelize.getQueryInterface();
const runUp = () =>
  (up as (c: { context: unknown }) => Promise<void>)({ context: qi() });

beforeAll(async () => {
  await sequelize.sync({ force: true });
  await Behavior.create({
    id: 1,
    title: "b",
    enabled: true,
    sortOrder: 0,
    stopOnMatch: false,
    forwardType: "continuous",
    source: "custom",
    triggerType: "message_pattern",
    messagePatternKind: "startswith",
    messagePatternValue: "!x",
    scope: "global",
    integrationTypes: "guild_install,user_install",
    contexts: "BotDM",
    audienceKind: "all",
    webhookUrl: encryptSecret("https://example.test/hook"),
    scopeTabId: 1,
  } as Record<string, unknown>);
});

describe("003-behavior-session-channel-pk", () => {
  it("1. rebuilds a legacy PK=userId table, preserving rows", async () => {
    // Recreate the LEGACY shape (PK = userId only).
    await qi().dropTable("behavior_sessions");
    await sequelize.query(
      `CREATE TABLE behavior_sessions (
         userId TEXT PRIMARY KEY,
         behaviorId INTEGER NOT NULL REFERENCES behaviors(id),
         channelId TEXT NOT NULL,
         startedAt TEXT NOT NULL,
         expiresAt TEXT,
         createdAt DATETIME NOT NULL,
         updatedAt DATETIME NOT NULL
       )`,
    );
    const now = new Date().toISOString();
    await sequelize.query(
      `INSERT INTO behavior_sessions
         (userId, behaviorId, channelId, startedAt, expiresAt, createdAt, updatedAt)
       VALUES ('u1', 1, 'dm-1', '${now}', NULL, '${now}', '${now}')`,
    );

    await runUp();

    // Row survived the rebuild…
    const rows = await sequelize.query<{ userId: string; channelId: string }>(
      "SELECT userId, channelId FROM behavior_sessions",
      { type: QueryTypes.SELECT },
    );
    expect(rows).toEqual([{ userId: "u1", channelId: "dm-1" }]);

    // …and the new shape accepts a second channel for the same user
    // (the legacy PK would have rejected this).
    await BehaviorSession.create({
      userId: "u1",
      behaviorId: 1,
      channelId: "guild-chan-2",
      startedAt: now,
      expiresAt: null,
    } as Record<string, unknown>);
    const count = await BehaviorSession.count({ where: { userId: "u1" } });
    expect(count).toBe(2);
  });

  it("2. no-ops on the already-migrated shape", async () => {
    const before = await BehaviorSession.count();
    await runUp(); // table already has channelId in the PK → must no-op
    const after = await BehaviorSession.count();
    expect(after).toBe(before);
  });
});

/**
 * Regression: behavior_sessions.expiresAt under the legacy DATE column
 * type stored as "YYYY-MM-DD HH:MM:SS.sss +00:00" (space-separated).
 * After flipping the column to STRING and the writer to toISOString(),
 * lexicographic compare against new ISO ('YYYY-MM-DDTHH:MM:SS.sssZ')
 * sees ' ' < 'T' and erroneously classifies every legacy row as expired
 * → findActiveSession's preflight destroys all of them.
 *
 * The migrateLegacyExpiresAt helper rewrites the legacy strings to ISO
 * before any findActiveSession runs.
 */

import { vi, describe, it, expect, beforeAll, beforeEach } from "vitest";

vi.hoisted(() => {
  process.env.SQLITE_DB_PATH = ":memory:";
});

import { sequelize } from "../src/db.js";
import {
  BehaviorSession,
  findActiveSession,
  migrateLegacyExpiresAt,
} from "../src/modules/behavior/models/behavior-session.model.js";
import { Behavior } from "../src/modules/behavior/models/behavior.model.js";

async function seedBehavior(id: number): Promise<void> {
  await Behavior.create({
    id,
    title: "t",
    enabled: true,
    sortOrder: 0,
    source: "custom",
    triggerType: "message_pattern",
    messagePatternKind: "startswith",
    messagePatternValue: "!",
    forwardType: "continuous",
    scope: "global",
    integrationTypes: "guild_install",
    contexts: "BotDM,PrivateChannel",
    audienceKind: "all",
    webhookUrl: "fake-encrypted",
    scopeTabId: 1,
  } as Record<string, unknown>);
}

async function seedLegacySession(
  userId: string,
  behaviorId: number,
  legacyExpiresAt: string,
): Promise<void> {
  await BehaviorSession.upsert({
    userId,
    behaviorId,
    channelId: "dm-channel",
    startedAt: new Date().toISOString(),
    expiresAt: legacyExpiresAt,
  });
}

beforeAll(async () => {
  await sequelize.sync({ force: true });
});

beforeEach(async () => {
  await BehaviorSession.destroy({ where: {} });
  await Behavior.destroy({ where: {} });
});

describe("migrateLegacyExpiresAt", () => {
  it("rewrites legacy space-separated DATE strings to ISO 8601", async () => {
    await seedBehavior(1);
    // Sequelize SQLite DATE format: 'YYYY-MM-DD HH:MM:SS.sss +00:00'
    const future = new Date(Date.now() + 3600_000);
    const yyyy = future.getUTCFullYear();
    const mm = String(future.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(future.getUTCDate()).padStart(2, "0");
    const hh = String(future.getUTCHours()).padStart(2, "0");
    const mi = String(future.getUTCMinutes()).padStart(2, "0");
    const ss = String(future.getUTCSeconds()).padStart(2, "0");
    const legacy = `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}.000 +00:00`;
    await seedLegacySession("u1", 1, legacy);

    const migrated = await migrateLegacyExpiresAt();
    expect(migrated).toBe(1);

    const row = await BehaviorSession.findOne({ where: { userId: "u1" } });
    const after = row?.getDataValue("expiresAt") as string;
    expect(after).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(new Date(after).getTime()).toBe(new Date(legacy).getTime());
  });

  it("findActiveSession PRESERVES a migrated future session (regression vs. the data-loss bug)", async () => {
    await seedBehavior(2);
    const future = new Date(Date.now() + 3600_000);
    const legacy = future.toISOString().replace("T", " ").replace("Z", " +00:00");
    await seedLegacySession("u2", 2, legacy);

    // BEFORE the migration: findActiveSession would have destroyed this row.
    // AFTER the migration: the row is preserved and returned.
    await migrateLegacyExpiresAt();
    const active = await findActiveSession("u2");
    expect(active).not.toBeNull();
    expect(active?.behaviorId).toBe(2);
  });

  it("is idempotent: ISO rows untouched on a second run", async () => {
    await seedBehavior(3);
    const iso = new Date(Date.now() + 3600_000).toISOString();
    await seedLegacySession("u3", 3, iso);

    const first = await migrateLegacyExpiresAt();
    expect(first).toBe(0); // already ISO
    const after = (
      await BehaviorSession.findOne({ where: { userId: "u3" } })
    )?.getDataValue("expiresAt");
    expect(after).toBe(iso);

    const second = await migrateLegacyExpiresAt();
    expect(second).toBe(0);
  });

  it("malformed legacy strings are left alone (no throw, no data loss)", async () => {
    await seedBehavior(4);
    await seedLegacySession("u4", 4, "not a date at all");
    const migrated = await migrateLegacyExpiresAt();
    expect(migrated).toBe(0);
    const after = (
      await BehaviorSession.findOne({ where: { userId: "u4" } })
    )?.getDataValue("expiresAt");
    expect(after).toBe("not a date at all");
  });
});

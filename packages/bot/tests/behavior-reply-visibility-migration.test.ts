/**
 * Migration 014 (#140): behavior_definitions gains replyVisibility — the
 * reply's default visibility, null on every existing row (the trigger's
 * own default). Re-running is a no-op.
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

import type { QueryInterface } from "sequelize";
import { sequelize, dbDialect } from "../src/db.js";
import "../src/modules/behavior/models/behavior-definition.model.js";
import "../src/modules/behavior/models/behavior-webhook-action.model.js";
import { up } from "../src/migrations/014-behavior-reply-visibility.js";
import { seedMessageTrigger } from "./behavior-fixtures.js";

const qi = (): QueryInterface => sequelize.getQueryInterface();
const runUp = () =>
  (up as (c: { context: QueryInterface }) => Promise<void>)({ context: qi() });

let existing: number;

beforeAll(async () => {
  if (dbDialect === "postgres") {
    await sequelize.query("DROP SCHEMA public CASCADE");
    await sequelize.query("CREATE SCHEMA public");
  }
  await sequelize.sync({ force: true });
  existing = await seedMessageTrigger({ title: "before 014" });
  // the table as it was before this migration
  await qi().removeColumn("behavior_definitions", "replyVisibility");
});

describe(`migration 014 (${dbDialect})`, () => {
  it("adds replyVisibility, null on existing rows", async () => {
    await runUp();
    const columns = await qi().describeTable("behavior_definitions");
    expect(columns).toHaveProperty("replyVisibility");
    expect(columns.replyVisibility!.allowNull).toBe(true);
    const [rows] = await sequelize.query(
      `SELECT "replyVisibility" FROM behavior_definitions WHERE id = ${existing}`,
    );
    expect(rows).toEqual([{ replyVisibility: null }]);
  });

  it("re-running is a no-op", async () => {
    await expect(runUp()).resolves.toBeUndefined();
  });
});

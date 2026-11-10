/**
 * Migration 015 (#113): behavior_deliveries gains `deferred` — false on
 * every existing delivery. Re-running is a no-op.
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
import "../src/modules/behavior/models/behavior-delivery.model.js";
import { up } from "../src/migrations/015-behavior-delivery-deferred.js";
import { findRecentDeliveries } from "../src/modules/behavior/behavior-deliveries.js";
import { seedMessageTrigger } from "./behavior-fixtures.js";

const qi = (): QueryInterface => sequelize.getQueryInterface();
const runUp = () =>
  (up as (c: { context: QueryInterface }) => Promise<void>)({ context: qi() });

let behaviorId: number;

beforeAll(async () => {
  if (dbDialect === "postgres") {
    await sequelize.query("DROP SCHEMA public CASCADE");
    await sequelize.query("CREATE SCHEMA public");
  }
  await sequelize.sync({ force: true });
  behaviorId = await seedMessageTrigger({ title: "before 015" });
  // the table as it was before this migration, with one delivery in it
  await qi().removeColumn("behavior_deliveries", "deferred");
  await qi().bulkInsert("behavior_deliveries", [
    { behaviorId, firedAt: new Date(), via: "message", ok: true, httpStatus: 200 },
  ]);
});

describe(`migration 015 (${dbDialect})`, () => {
  it("adds deferred, false on existing deliveries", async () => {
    await runUp();
    const columns = await qi().describeTable("behavior_deliveries");
    expect(columns).toHaveProperty("deferred");
    expect(columns.deferred!.allowNull).toBe(false);
    const rows = await findRecentDeliveries(behaviorId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ ok: true, deferred: false });
  });

  it("re-running is a no-op", async () => {
    await expect(runUp()).resolves.toBeUndefined();
  });
});

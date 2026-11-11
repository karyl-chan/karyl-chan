/**
 * Migration 016 (#126): behavior_definitions gains serviceId (null on every
 * existing row) and a unique index over its non-null values. Re-running
 * is a no-op.
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
import { Service } from "../src/modules/behavior/models/service.model.js";
import { up } from "../src/migrations/016-behavior-service-id.js";
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
  existing = await seedMessageTrigger({ title: "before 016" });
  // the table as it was before this migration
  await qi().removeColumn("behavior_definitions", "serviceId");
});

describe(`migration 016 (${dbDialect})`, () => {
  it("adds serviceId, null on existing rows", async () => {
    await runUp();
    const columns = await qi().describeTable("behavior_definitions");
    expect(columns).toHaveProperty("serviceId");
    expect(columns.serviceId!.allowNull).toBe(true);
    const [rows] = await sequelize.query(
      `SELECT "serviceId" FROM behavior_definitions WHERE id = ${existing}`,
    );
    expect(rows).toEqual([{ serviceId: null }]);
  });

  it("keeps one behavior per service, any number without one", async () => {
    const service = await Service.create({
      name: "NAS",
      audience: "nas",
      redirectUrl: "https://nas.example/cb",
    });
    const serviceId = service.getDataValue("id") as number;
    const row = (n: string) => ({
      title: n,
      sortOrder: -2000,
      actionSource: "service",
      serviceId,
      stopOnMatch: true,
      patternKind: "regex",
      patternValue: "^!login-nas$",
    });
    await seedMessageTrigger(row("first"), null);
    await expect(seedMessageTrigger(row("second"), null)).rejects.toThrow();
    // null is not unique-checked
    await seedMessageTrigger({ title: "another custom" });
  });

  it("re-running is a no-op", async () => {
    await expect(runUp()).resolves.toBeUndefined();
  });
});

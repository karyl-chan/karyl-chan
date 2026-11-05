/**
 * Migration 013 (#137, from #116): member lists of audience groups no
 * message trigger uses are deleted once; lists of groups in use stay.
 * Re-running deletes nothing.
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
import { botEventLog } from "../src/modules/bot-events/bot-event-log.js";
import {
  BehaviorGroupMember,
  findGroupMembers,
} from "../src/modules/behavior/models/behavior-group-member.model.js";
import "../src/modules/behavior/models/behavior-definition.model.js";
import "../src/modules/behavior/models/behavior-webhook-action.model.js";
import { up } from "../src/migrations/013-drop-unused-group-members.js";
import { seedMessageTrigger } from "./behavior-fixtures.js";

const qi = (): QueryInterface => sequelize.getQueryInterface();
const runUp = () =>
  (up as (c: { context: QueryInterface }) => Promise<void>)({ context: qi() });

const A = "111111111111111111";
const B = "222222222222222222";

beforeAll(async () => {
  if (dbDialect === "postgres") {
    await sequelize.query("DROP SCHEMA public CASCADE");
    await sequelize.query("CREATE SCHEMA public");
  }
  await sequelize.sync({ force: true });
  await seedMessageTrigger({ title: "ops only", audienceKind: "group", audienceGroupName: "ops" });
  await BehaviorGroupMember.bulkCreate([
    { groupName: "ops", userId: A },
    { groupName: "ghost", userId: A },
    { groupName: "ghost", userId: B },
    { groupName: "left-over", userId: B },
  ]);
});

describe("migration 013", () => {
  it("deletes the lists of groups no message trigger uses and logs the count", async () => {
    await runUp();
    expect(await findGroupMembers("ops")).toEqual([A]);
    expect(await findGroupMembers("ghost")).toEqual([]);
    expect(await findGroupMembers("left-over")).toEqual([]);
    expect(botEventLog.record).toHaveBeenLastCalledWith(
      "info",
      "bot",
      expect.stringContaining("removed 3"),
      expect.objectContaining({ removed: 3, groups: expect.arrayContaining(["ghost", "left-over"]) }),
    );
  });

  it("re-running deletes nothing", async () => {
    await runUp();
    expect(await findGroupMembers("ops")).toEqual([A]);
    expect(botEventLog.record).toHaveBeenLastCalledWith(
      "info",
      "bot",
      expect.stringContaining("removed 0"),
      expect.objectContaining({ removed: 0, groups: [] }),
    );
  });
});

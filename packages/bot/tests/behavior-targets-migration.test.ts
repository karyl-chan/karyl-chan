/**
 * Migration 017 (ADR 0004): every Behavior Target already in use gets a
 * row in the directory — groups named by a trigger, by a DM allowlist or
 * still holding members; users bot DM triggers are for; guilds and
 * channels triggers and commands are placed in. A trigger's group name is
 * trimmed first. Re-running adds nothing; down drops the table.
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
import { BehaviorDefinition } from "../src/modules/behavior/models/behavior-definition.model.js";
import { BehaviorDmAllowlist } from "../src/modules/behavior/models/behavior-dm-allowlist.model.js";
import { BehaviorGroupMember } from "../src/modules/behavior/models/behavior-group-member.model.js";
import { findBehaviorTargets } from "../src/modules/behavior/models/behavior-target.model.js";
import "../src/modules/behavior/models/behavior-command.model.js";
import "../src/modules/behavior/models/behavior-webhook-action.model.js";
import { up, down } from "../src/migrations/017-behavior-targets.js";
import { seedBehaviorTarget, seedCommand, seedLeaf, seedMessageTrigger, seedSystemLogin } from "./behavior-fixtures.js";

const qi = (): QueryInterface => sequelize.getQueryInterface();
const run = (fn: typeof up) =>
  (fn as (c: { context: QueryInterface }) => Promise<void>)({ context: qi() });

const U = "111111111111111111";
const G = "222222222222222222";
const C = "333333333333333333";

const EXPECTED = [
  `channel:${G}:${C}`,
  "group:allowlisted",
  "group:left-over",
  "group:ops",
  "group:padded",
  `guild:${G}`,
  `user:${U}`,
];

let padded: number;

beforeAll(async () => {
  if (dbDialect === "postgres") {
    await sequelize.query("DROP SCHEMA public CASCADE");
    await sequelize.query("CREATE SCHEMA public");
  }
  await sequelize.sync({ force: true });

  // built-in targets: no row
  await seedSystemLogin();
  await seedMessageTrigger({ title: "everyone in dm", stopOnMatch: true });
  await seedMessageTrigger({ title: "all guilds", surface: "guild" });
  const appCommand = await seedCommand({ name: "app", contexts: "BotDM,Guild" });
  await seedLeaf(appCommand);

  // created targets
  await seedMessageTrigger({ title: "one user", audienceKind: "user", audienceUserId: U });
  await seedMessageTrigger({ title: "ops only", audienceKind: "group", audienceGroupName: "ops", stopOnMatch: true });
  padded = await seedMessageTrigger({ title: "padded", audienceKind: "group", audienceGroupName: " padded " });
  await seedMessageTrigger({ title: "a channel", surface: "guild", guildId: G, channelId: C });
  const guildCommand = await seedCommand({ name: "nas", registration: "guild", guildId: G });
  await seedLeaf(guildCommand);

  const withList = await seedMessageTrigger({ title: "dms others" });
  await BehaviorDmAllowlist.create({
    behaviorId: withList,
    userIds: JSON.stringify([U]),
    groupNames: JSON.stringify(["allowlisted", "ops"]),
  });
  await BehaviorGroupMember.bulkCreate([
    { groupName: "ops", userId: U },
    { groupName: "left-over", userId: U },
  ]);
});

describe("migration 017", () => {
  it("registers every target in use and trims a trigger's group name", async () => {
    await run(up);
    const rows = await findBehaviorTargets();
    expect(rows.map((r) => r.key).sort()).toEqual(EXPECTED);
    expect(rows.find((r) => r.key === `channel:${G}:${C}`)).toMatchObject({
      kind: "channel",
      guildId: G,
      channelId: C,
      userId: null,
      groupName: null,
    });
    expect(rows.find((r) => r.key === "group:padded")).toMatchObject({ kind: "group", groupName: "padded" });

    const trigger = await BehaviorDefinition.findByPk(padded);
    expect(trigger!.getDataValue("audienceGroupName")).toBe("padded");

    expect(botEventLog.record).toHaveBeenLastCalledWith(
      "info",
      "bot",
      expect.stringContaining("registered 7"),
      // the login always stops; with the two custom triggers that is three
      expect.objectContaining({ registered: EXPECTED, trimmedGroupNames: [" padded "], stopOnMatch: 3 }),
    );
  });

  it("re-running adds nothing", async () => {
    await run(up);
    expect((await findBehaviorTargets()).map((r) => r.key).sort()).toEqual(EXPECTED);
    expect(botEventLog.record).toHaveBeenLastCalledWith(
      "info",
      "bot",
      expect.stringContaining("registered 0"),
      expect.objectContaining({ registered: [], trimmedGroupNames: [] }),
    );
  });

  it("leaves a target the admin created alone", async () => {
    await seedBehaviorTarget("group:spare");
    await run(up);
    expect((await findBehaviorTargets()).map((r) => r.key)).toContain("group:spare");
  });

  it("down drops the table", async () => {
    await run(down);
    await expect(qi().describeTable("behavior_targets")).rejects.toThrow();
    // nothing to fill on a database without the table
    await run(up);
  });
});

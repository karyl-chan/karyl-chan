/**
 * #119 — at boot the bot says, in the bot event log, what its regex
 * triggers will not do: that it runs without the linear-time engine
 * (degraded: safe-regex2 at save time, the normal engine at runtime),
 * and which stored regex triggers it cannot run (they never match).
 */
import { vi, describe, it, expect, beforeAll, beforeEach } from "vitest";

vi.hoisted(() => {
  process.env.SQLITE_DB_PATH = ":memory:";
  process.env.ENCRYPTION_KEY = "a".repeat(64);
});

vi.mock("../src/modules/bot-events/bot-event-log.js", () => ({
  botEventLog: { record: vi.fn() },
}));

import { sequelize } from "../src/db.js";
import { botEventLog } from "../src/modules/bot-events/bot-event-log.js";
import { checkRegexTriggersAtBoot } from "../src/modules/behavior/regex-trigger-boot-check.js";
import { compileTriggerRegex } from "../src/utils/linear-regex.js";
import { clearBehaviors, seedMessageTrigger } from "./behavior-fixtures.js";

beforeAll(async () => {
  await sequelize.sync({ force: true });
});

beforeEach(async () => {
  vi.mocked(botEventLog.record).mockClear();
  await clearBehaviors();
});

const warnings = () =>
  vi.mocked(botEventLog.record).mock.calls.filter(([level]) => level === "warn");

describe("checkRegexTriggersAtBoot", () => {
  it("with the engine this process has, says nothing when every stored regex runs", async () => {
    await seedMessageTrigger({ patternKind: "regex", patternValue: "^天氣\\s+(.+)" });
    await seedMessageTrigger({ patternKind: "startswith", patternValue: "(a)\\1" });
    await checkRegexTriggersAtBoot();
    // (without the engine, the one degraded-mode line still comes; it names no trigger)
    expect(warnings().filter(([, , , meta]) => meta !== undefined)).toEqual([]);
  });

  it("names each stored regex trigger this process cannot run", async () => {
    // a pattern the save check would refuse here, stored before it existed
    const pattern = ["(a)\\1", "(?=a)a", "x{1,1000}", "(a+)+"].find(
      (p) => compileTriggerRegex(p) === null,
    )!;
    const id = await seedMessageTrigger({ patternKind: "regex", patternValue: pattern });
    await checkRegexTriggersAtBoot();
    expect(warnings()).toHaveLength(1);
    expect(warnings()[0][3]).toMatchObject({ behaviorId: id, patternValue: pattern });
  });

  it("without the linear engine, warns once that regex triggers run degraded", async () => {
    await checkRegexTriggersAtBoot(false);
    expect(warnings()).toHaveLength(1);
    expect(warnings()[0][2]).toMatch(/linear/);
  });
});

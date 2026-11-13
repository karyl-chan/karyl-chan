/**
 * Tests never run startup, which is what syncs bot_events — so on the
 * suite-wide in-memory events DB (vitest.config.ts) every unmocked
 * botEventLog.record() used to fail with "no such table: bot_events" and log
 * "DB write failed", ~1000 lines per full run. record() itself must create the
 * table on an in-memory DB. This file deliberately does no sync of its own.
 */
import { vi, describe, it, expect } from "vitest";

vi.hoisted(() => {
  process.env.SQLITE_DB_PATH = ":memory:";
});

import { BotEvent } from "../src/modules/bot-events/models/bot-event.model.js";
import { botEventLog } from "../src/modules/bot-events/bot-event-log.js";

describe("botEventLog.record on the in-memory events DB", () => {
  it("creates bot_events before its first write, with no manual sync", async () => {
    botEventLog.record("info", "bot", "first event");

    // count() itself throws while the table is missing.
    await vi.waitFor(async () => expect(await BotEvent.count()).toBe(1));
  });
});

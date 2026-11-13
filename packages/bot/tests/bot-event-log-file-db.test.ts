/**
 * The in-memory events DB gets its bot_events table from record() itself
 * (see bot-event-log-memory-schema.test.ts). A file-backed DB must not: there
 * startup's botEventsSequelize.sync() owns the table, and record() is a hot
 * path that should stay a bare create().
 */
import { vi, describe, it, expect, afterEach } from "vitest";

await vi.hoisted(async () => {
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  process.env.SQLITE_DB_PATH = ":memory:";
  // Never opened: sync() and create() are stubbed below, and Sequelize only
  // connects on a query.
  process.env.BOT_EVENTS_SQLITE_DB_PATH = join(
    tmpdir(),
    `karyl-bot-events-${process.pid}.sqlite`,
  );
});

import { BotEvent } from "../src/modules/bot-events/models/bot-event.model.js";
import { botEventsDbPath } from "../src/modules/bot-events/bot-events-db.js";
import { botEventLog } from "../src/modules/bot-events/bot-event-log.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("botEventLog.record on a file-backed events DB", () => {
  it("writes without syncing the schema", async () => {
    // Pin the precondition: a Postgres env would share the main DB and pass
    // this test without ever exercising a file-backed SQLite path.
    expect(botEventsDbPath).toBe(process.env.BOT_EVENTS_SQLITE_DB_PATH);
    const sync = vi.spyOn(BotEvent, "sync").mockResolvedValue({} as never);
    const create = vi.spyOn(BotEvent, "create").mockResolvedValue({} as never);

    botEventLog.record("info", "bot", "file-backed event");
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1));

    expect(sync).not.toHaveBeenCalled();
  });
});

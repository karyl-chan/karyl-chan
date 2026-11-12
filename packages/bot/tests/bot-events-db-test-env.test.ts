/**
 * Guards the suite-wide test env in vitest.config.ts.
 *
 * bot_events has its own SQLite file. Unset, BOT_EVENTS_SQLITE_DB_PATH
 * resolves to the package's real data/bot-events.sqlite — shared by every
 * parallel test run, table-less in a fresh checkout ("no such table:
 * bot_events"), and in the main checkout the test station's bind-mounted
 * event log. This file deliberately sets no env of its own: it proves the
 * default every test file inherits is an in-memory DB.
 */

import { describe, it, expect } from "vitest";
import { botEventsDbPath } from "../src/modules/bot-events/bot-events-db.js";

describe("bot events DB under test", () => {
  it("defaults to an in-memory SQLite DB, not data/bot-events.sqlite", () => {
    expect(botEventsDbPath).toBe(":memory:");
  });
});

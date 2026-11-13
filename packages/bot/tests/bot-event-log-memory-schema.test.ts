/**
 * Tests never run startup, which is what syncs bot_events — so on the
 * suite-wide in-memory events DB (vitest.config.ts) every unmocked
 * botEventLog.record() used to fail with "no such table: bot_events" and log
 * "DB write failed", ~1000 lines per full run. record() itself must create the
 * table on an in-memory DB. This file deliberately does no sync of its own.
 */
import { vi, describe, it, expect, afterEach } from "vitest";

const { logError } = vi.hoisted(() => {
  process.env.SQLITE_DB_PATH = ":memory:";
  return { logError: vi.fn() };
});

vi.mock("../src/logger.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/logger.js")>();
  return {
    ...actual,
    moduleLogger: (name: string) => {
      const child = actual.moduleLogger(name);
      if (name !== "bot-event-log") return child;
      return new Proxy(child, {
        get: (target, prop, receiver) =>
          prop === "error" ? logError : Reflect.get(target, prop, receiver),
      });
    },
  };
});

import { BotEvent } from "../src/modules/bot-events/models/bot-event.model.js";
import { botEventLog } from "../src/modules/bot-events/bot-event-log.js";

// record() is fire-and-forget; poll until the write either lands or fails.
async function settled(): Promise<void> {
  await vi.waitFor(
    async () => {
      if (logError.mock.calls.length > 0) return;
      const count = await BotEvent.count().catch(() => 0);
      if (count === 0) throw new Error("write not landed yet");
    },
    { timeout: 2000, interval: 10 },
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  logError.mockClear();
});

describe("botEventLog.record on the in-memory events DB", () => {
  it("creates bot_events before its first write, with no manual sync", async () => {
    botEventLog.record("info", "bot", "first event");
    await settled();

    expect(logError).not.toHaveBeenCalled();
    expect(await BotEvent.count()).toBe(1);
  });

  it("logs a failed schema sync as a failed write and retries it on the next record", async () => {
    // Fresh module graph: a fresh in-memory DB and a record() whose one-off
    // sync has not run yet (the test above already ran it in this graph).
    vi.resetModules();
    const { BotEvent: FreshBotEvent } =
      await import("../src/modules/bot-events/models/bot-event.model.js");
    const { botEventLog: freshLog } =
      await import("../src/modules/bot-events/bot-event-log.js");
    vi.spyOn(FreshBotEvent, "sync").mockRejectedValueOnce(
      new Error("sync down"),
    );

    freshLog.record("info", "bot", "lost to the failed sync");
    await vi.waitFor(() => expect(logError).toHaveBeenCalledTimes(1));
    expect(logError).toHaveBeenCalledWith(
      { err: expect.objectContaining({ message: "sync down" }) },
      "DB write failed",
    );

    logError.mockClear();
    freshLog.record("info", "bot", "after the sync recovers");
    await vi.waitFor(async () => expect(await FreshBotEvent.count()).toBe(1));
    expect(logError).not.toHaveBeenCalled();
  });
});

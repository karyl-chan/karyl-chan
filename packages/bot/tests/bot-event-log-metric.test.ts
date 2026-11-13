/**
 * botEventLog.record() must increment the write metric only AFTER the DB write
 * lands. The old code incremented synchronously before BotEvent.create(), so a
 * DB outage over-reported the counter while the audit trail was silently blank.
 */
import { vi, describe, it, expect, afterEach } from "vitest";

vi.hoisted(() => {
  process.env.SQLITE_DB_PATH = ":memory:";
});

import { BotEvent } from "../src/modules/bot-events/models/bot-event.model.js";
import {
  botEventLog,
  setBotEventLogMetric,
} from "../src/modules/bot-events/bot-event-log.js";

// On the in-memory events DB record() first awaits a one-off bot_events
// sync, so wait for the create() to be issued, then let a macrotask tick
// pass so its .then()/.catch() runs.
async function settled(create: ReturnType<typeof vi.spyOn>): Promise<void> {
  await vi.waitFor(() => expect(create).toHaveBeenCalled());
  await new Promise<void>((r) => setImmediate(r));
}

afterEach(() => {
  vi.restoreAllMocks();
  setBotEventLogMetric(null);
});

describe("botEventLog.record metric", () => {
  it("increments the write metric after the DB write succeeds", async () => {
    const inc = vi.fn();
    setBotEventLogMetric({ inc });
    const create = vi.spyOn(BotEvent, "create").mockResolvedValue({} as never);

    botEventLog.record("info", "bot", "hello");
    await settled(create);

    expect(inc).toHaveBeenCalledTimes(1);
    expect(inc).toHaveBeenCalledWith({ level: "info", category: "bot" });
  });

  it("does NOT increment the metric when the DB write fails", async () => {
    const inc = vi.fn();
    setBotEventLogMetric({ inc });
    const create = vi
      .spyOn(BotEvent, "create")
      .mockRejectedValue(new Error("db down"));

    botEventLog.record("warn", "auth", "boom");
    await settled(create);

    expect(inc).not.toHaveBeenCalled();
  });
});

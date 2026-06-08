/**
 * Unit tests for expireStalePlugins (the heartbeat reaper's DB sweep).
 *
 * The reaper caller acts on the returned ids destructively — it revokes
 * each plugin's bearer token and drops it from the event index — so the
 * sweep must be race-safe: a heartbeat that revives a row between the
 * internal SELECT and UPDATE must neither be flipped back to inactive nor
 * reported as expired.
 */
import { vi, describe, it, expect, beforeEach } from "vitest";

vi.hoisted(() => {
  process.env.SQLITE_DB_PATH = ":memory:";
});

import { sequelize } from "../src/db.js";
import {
  Plugin,
  expireStalePlugins,
} from "../src/modules/plugin-system/models/plugin.model.js";

const CUTOFF = new Date("2026-01-01T00:00:00Z");
const STALE = new Date("2025-12-31T23:00:00Z"); // before cutoff → expirable
const FRESH = new Date("2026-01-01T01:00:00Z"); // after cutoff → alive

async function makePlugin(
  key: string,
  status: "active" | "inactive",
  lastHeartbeatAt: Date | null,
): Promise<number> {
  const row = await Plugin.create({
    pluginKey: key,
    name: key,
    version: "1.0.0",
    url: "http://example.test",
    manifestJson: "{}",
    status,
    lastHeartbeatAt,
  });
  return row.getDataValue("id") as number;
}

async function statusOf(id: number): Promise<string> {
  const row = await Plugin.findByPk(id);
  return row!.getDataValue("status") as string;
}

beforeEach(async () => {
  await sequelize.sync({ force: true });
});

describe("expireStalePlugins", () => {
  it("expires active plugins with stale heartbeats and returns their ids", async () => {
    const id = await makePlugin("stale", "active", STALE);
    const ids = await expireStalePlugins(CUTOFF);
    expect(ids).toEqual([id]);
    expect(await statusOf(id)).toBe("inactive");
  });

  it("leaves active plugins with fresh heartbeats untouched", async () => {
    const id = await makePlugin("fresh", "active", FRESH);
    const ids = await expireStalePlugins(CUTOFF);
    expect(ids).toEqual([]);
    expect(await statusOf(id)).toBe("active");
  });

  it("ignores already-inactive plugins", async () => {
    await makePlugin("dead", "inactive", STALE);
    const ids = await expireStalePlugins(CUTOFF);
    expect(ids).toEqual([]);
  });

  it("does not expire or return a plugin that heartbeats during the sweep", async () => {
    // The row is stale at SELECT time, so it enters the candidate set.
    const id = await makePlugin("racer", "active", STALE);

    // Simulate a heartbeat landing in the SELECT→UPDATE window by reviving
    // the row via an instance update (which does not hit the spied static
    // Plugin.update) right before the real UPDATE runs.
    const realUpdate = Plugin.update.bind(Plugin);
    const spy = vi
      .spyOn(Plugin, "update")
      .mockImplementationOnce(async (values: unknown, options: unknown) => {
        const row = await Plugin.findByPk(id);
        await row!.update({ status: "active", lastHeartbeatAt: FRESH });
        return realUpdate(
          values as Parameters<typeof realUpdate>[0],
          options as Parameters<typeof realUpdate>[1],
        );
      });

    const ids = await expireStalePlugins(CUTOFF);
    spy.mockRestore();

    // The revived plugin must not be clobbered back to inactive...
    expect(await statusOf(id)).toBe("active");
    // ...and must not be reported as expired (the caller would revoke its
    // token + evict it from the event index otherwise).
    expect(ids).toEqual([]);
  });
});

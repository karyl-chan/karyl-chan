import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __resetReadinessForTests,
  getReadiness,
  isDraining,
  setBotSkipped,
  setDraining,
  setReady,
} from "../src/modules/web-core/readiness.js";

describe("readiness + drain state", () => {
  beforeEach(() => {
    __resetReadinessForTests();
  });
  afterEach(() => {
    __resetReadinessForTests();
  });

  it("is not ready before any signal flips", () => {
    expect(getReadiness()).toEqual({
      db: false,
      bot: false,
      botMode: "gateway",
      draining: false,
      ready: false,
    });
  });

  it("BOT_SKIP_DISCORD: setBotSkipped satisfies the bot signal (PM-7.5)", () => {
    setReady("db", true);
    expect(getReadiness().ready).toBe(false);
    setBotSkipped();
    expect(getReadiness()).toMatchObject({
      ready: true,
      bot: true,
      botMode: "skipped",
    });
    // Drain still wins over the skipped-bot signal.
    setDraining();
    expect(getReadiness().ready).toBe(false);
  });

  it("flips to ready when both boot signals are true", () => {
    setReady("db", true);
    setReady("bot", true);
    expect(getReadiness().ready).toBe(true);
  });

  it("becomes not-ready the moment setDraining is called", () => {
    setReady("db", true);
    setReady("bot", true);
    expect(getReadiness().ready).toBe(true);
    setDraining();
    expect(getReadiness()).toMatchObject({
      ready: false,
      draining: true,
      db: true,
      bot: true,
    });
    expect(isDraining()).toBe(true);
  });

  it("setDraining is idempotent (calling twice is harmless)", () => {
    setDraining();
    setDraining();
    expect(isDraining()).toBe(true);
  });

  it("draining is one-way — setReady cannot revive a draining instance", () => {
    setReady("db", true);
    setReady("bot", true);
    setDraining();
    // Flipping boot signals again does not undo drain.
    setReady("db", true);
    setReady("bot", true);
    expect(getReadiness().ready).toBe(false);
    expect(getReadiness().draining).toBe(true);
  });
});

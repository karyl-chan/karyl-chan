import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InProcessPluginHealthStore } from "../src/adapters/plugin-health-store.js";
import { InProcessPluginMetricsStore } from "../src/adapters/plugin-metrics-store.js";

const emptyMetrics = { ts: 0, counters: [], gauges: [], histograms: [] };

describe("InProcessPluginMetricsStore", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns the latest snapshot, stamps receivedAt", () => {
    const t0 = new Date("2026-05-27T00:00:00Z").getTime();
    vi.setSystemTime(t0);
    const store = new InProcessPluginMetricsStore();
    store.setSnapshot("p1", emptyMetrics);
    expect(store.getSnapshot("p1")).toMatchObject({
      ts: 0,
      receivedAt: t0,
    });
  });

  it("drops snapshots older than 5 min on read", () => {
    const t0 = new Date("2026-05-27T00:00:00Z").getTime();
    vi.setSystemTime(t0);
    const store = new InProcessPluginMetricsStore();
    store.setSnapshot("p1", emptyMetrics);
    vi.setSystemTime(t0 + 5 * 60 * 1000 + 1);
    expect(store.getSnapshot("p1")).toBeNull();
  });

  it("returns null for unknown plugin without storing it", () => {
    const store = new InProcessPluginMetricsStore();
    expect(store.getSnapshot("never-pushed")).toBeNull();
  });

  it("clear drops the snapshot", () => {
    const store = new InProcessPluginMetricsStore();
    store.setSnapshot("p1", emptyMetrics);
    store.clearSnapshot("p1");
    expect(store.getSnapshot("p1")).toBeNull();
  });
});

describe("InProcessPluginHealthStore", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const healthy = { status: "healthy" as const, checkedAt: 0 };

  it("round-trips a fresh entry", () => {
    const t0 = new Date("2026-05-27T00:00:00Z").getTime();
    vi.setSystemTime(t0);
    const store = new InProcessPluginHealthStore();
    store.setHealth("p1", healthy);
    expect(store.getHealth("p1")?.receivedAt).toBe(t0);
  });

  it("drops entries older than 5 min on read", () => {
    const t0 = new Date("2026-05-27T00:00:00Z").getTime();
    vi.setSystemTime(t0);
    const store = new InProcessPluginHealthStore();
    store.setHealth("p1", healthy);
    vi.setSystemTime(t0 + 5 * 60 * 1000 + 1);
    expect(store.getHealth("p1")).toBeNull();
  });

  it("clearHealth removes the entry", () => {
    const store = new InProcessPluginHealthStore();
    store.setHealth("p1", healthy);
    store.clearHealth("p1");
    expect(store.getHealth("p1")).toBeNull();
  });
});

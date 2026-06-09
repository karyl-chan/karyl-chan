import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

// Import after potential hoisting so the module-level Map starts fresh
// for each test via vi.resetModules() in beforeEach.
describe("bot-event-dedup", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
  });

  async function importFresh() {
    const mod = await import(
      "../src/modules/bot-events/bot-event-dedup.js?t=" + Date.now()
    );
    return mod.shouldRecord;
  }

  it("returns true on the first call for a key", async () => {
    const shouldRecord = await importFresh();
    expect(shouldRecord("event:a")).toBe(true);
  });

  it("returns false on a second call within the window", async () => {
    const shouldRecord = await importFresh();
    shouldRecord("event:b");
    vi.advanceTimersByTime(30_000); // still inside 60s window
    expect(shouldRecord("event:b")).toBe(false);
  });

  it("returns true after the window has elapsed", async () => {
    const shouldRecord = await importFresh();
    shouldRecord("event:c");
    vi.advanceTimersByTime(60_001);
    expect(shouldRecord("event:c")).toBe(true);
  });

  it("different keys are independent — one suppressed does not affect another", async () => {
    const shouldRecord = await importFresh();
    shouldRecord("key:x");
    vi.advanceTimersByTime(10_000);
    // key:x is suppressed, key:y has never been seen
    expect(shouldRecord("key:x")).toBe(false);
    expect(shouldRecord("key:y")).toBe(true);
  });

  it("evicts the oldest key when the 1000-key cap is reached", async () => {
    const shouldRecord = await importFresh();
    // Fill the map to 999 with cheap filler keys that are never reused.
    for (let i = 0; i < 999; i++) {
      shouldRecord(`filler:${i}`);
    }
    // Record the key we care about — it becomes the 1000th entry.
    shouldRecord("sentinel");
    // The 1001st insert should evict 'filler:0' (oldest / first-inserted).
    shouldRecord("overflow");
    // 'sentinel' was recorded AFTER all fillers and before 'overflow',
    // so it is still within the map — within-window call returns false.
    expect(shouldRecord("sentinel")).toBe(false);
    // 'filler:0' was the first inserted and should have been evicted,
    // so a fresh call for it is treated as a new key → true.
    expect(shouldRecord("filler:0")).toBe(true);
  });

  it("does not cap-evict a frequently-recurring key mid-window", async () => {
    const shouldRecord = await importFresh();
    // 'recurring' is recorded first, then the map is filled to the cap with
    // distinct fillers — so 'recurring' is the first-inserted (FIFO head).
    expect(shouldRecord("recurring")).toBe(true);
    for (let i = 0; i < 999; i++) shouldRecord(`filler:${i}`);
    // 'recurring' fires again inside its window: suppressed, but the fix
    // refreshes its recency (the old FIFO scheme left it stranded at the head).
    vi.advanceTimersByTime(1_000);
    expect(shouldRecord("recurring")).toBe(false);
    // A new key forces an eviction. Under the old FIFO-by-insertion logic this
    // evicted 'recurring' (the head), and the next call below would wrongly
    // return true (dedup bypassed). With LRU-by-use it evicts a stale filler
    // instead, so 'recurring' stays suppressed.
    shouldRecord("flood");
    expect(shouldRecord("recurring")).toBe(false);
  });
});

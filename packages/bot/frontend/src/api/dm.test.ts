import { describe, expect, it, vi } from "vitest";

// Capture what subscribeEvents wires into openTicketedSse so we can drive the
// SSE frames ourselves and assert the reconnect/replay plumbing.
const h = vi.hoisted(() => ({
  handlers: undefined as
    | {
        getLastEventId?: () => string | undefined;
        bindEventListeners: (s: {
          addEventListener: (n: string, fn: (e: unknown) => void) => void;
        }) => void;
      }
    | undefined,
  listeners: {} as Record<string, (e: unknown) => void>,
}));

vi.mock("./client", () => ({
  ApiError: class extends Error {},
  authedFetch: vi.fn(),
  jsonOrThrow: vi.fn(),
  openTicketedSse: (_path: string, handlers: NonNullable<typeof h.handlers>) => {
    h.handlers = handlers;
    h.listeners = {};
    handlers.bindEventListeners({
      addEventListener: (n, fn) => {
        h.listeners[n] = fn;
      },
    });
    return () => {};
  },
}));

import { subscribeEvents } from "./dm";

describe("subscribeEvents reconnect plumbing", () => {
  it("tracks the last stream id from frames and exposes it for reconnect", () => {
    const events: Array<{ type: string }> = [];
    subscribeEvents({ onEvent: (e) => events.push(e) });

    expect(h.handlers?.getLastEventId?.()).toBeUndefined();

    h.listeners["message-created"]({
      data: JSON.stringify({ type: "message-created", channelId: "c1", message: { id: "m1" } }),
      lastEventId: "ep:5",
    });

    expect(h.handlers?.getLastEventId?.()).toBe("ep:5");
    expect(events).toHaveLength(1);
  });

  it("routes a resync frame to onResync and adopts its id", () => {
    let resynced = 0;
    subscribeEvents({ onEvent: () => {}, onResync: () => resynced++ });

    h.listeners["resync"]({ data: "{}", lastEventId: "ep:9" });

    expect(resynced).toBe(1);
    expect(h.handlers?.getLastEventId?.()).toBe("ep:9");
  });
});

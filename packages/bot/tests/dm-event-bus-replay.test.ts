import { describe, expect, it } from "vitest";
import { DmEventBus, type DmEvent } from "../src/modules/dm-inbox/dm-event-bus.js";

function msg(channelId: string, id: string): DmEvent {
  return {
    type: "message-created",
    channelId,
    message: { id },
  } as unknown as DmEvent;
}
function typing(channelId: string): DmEvent {
  return {
    type: "typing-start",
    channelId,
    userId: "u",
    userName: "n",
    startedAt: 0,
  };
}

describe("DmEventBus reconnect replay", () => {
  it("assigns monotonic <epoch>:<seq> ids and delivers (event, id) to subscribers", () => {
    const bus = new DmEventBus({ epoch: "ep", bufferMax: 10 });
    const seen: string[] = [];
    bus.subscribe((_e, id) => seen.push(id));
    bus.publish(msg("c1", "m1"));
    bus.publish(msg("c1", "m2"));
    expect(seen).toEqual(["ep:1", "ep:2"]);
    expect(bus.latestId()).toBe("ep:2");
  });

  it("replaySince returns the durable events after the given id", () => {
    const bus = new DmEventBus({ epoch: "ep", bufferMax: 10 });
    bus.publish(msg("c1", "m1"));
    bus.publish(msg("c1", "m2"));
    bus.publish(msg("c1", "m3"));
    const r = bus.replaySince("ep:1");
    expect(r.kind).toBe("replay");
    if (r.kind === "replay") {
      expect(r.events.map((e) => e.id)).toEqual(["ep:2", "ep:3"]);
    }
  });

  it("reports caughtUp when the client is already at the head", () => {
    const bus = new DmEventBus({ epoch: "ep", bufferMax: 10 });
    bus.publish(msg("c1", "m1"));
    expect(bus.replaySince("ep:1").kind).toBe("caughtUp");
  });

  it("resyncs on an epoch mismatch (server restarted)", () => {
    const bus = new DmEventBus({ epoch: "ep2", bufferMax: 10 });
    bus.publish(msg("c1", "m1"));
    expect(bus.replaySince("ep1:5").kind).toBe("resync");
  });

  it("resyncs only when the gap predates the retained buffer", () => {
    const bus = new DmEventBus({ epoch: "ep", bufferMax: 2 });
    bus.publish(msg("c1", "m1")); // ep:1 — evicted below
    bus.publish(msg("c1", "m2")); // ep:2
    bus.publish(msg("c1", "m3")); // ep:3 → buffer [m2,m3], evicted up to seq 1
    // Client last saw ep:1; events after it (2,3) are still buffered → replay.
    expect(bus.replaySince("ep:1").kind).toBe("replay");
    // Client last saw nothing (ep:0); event 1 was evicted → can't serve.
    expect(bus.replaySince("ep:0").kind).toBe("resync");
  });

  it("does not buffer or replay transient typing events", () => {
    const bus = new DmEventBus({ epoch: "ep", bufferMax: 10 });
    bus.publish(msg("c1", "m1")); // ep:1
    bus.publish(typing("c1")); // ep:2 — transient, not buffered
    bus.publish(msg("c1", "m2")); // ep:3
    const r = bus.replaySince("ep:1");
    expect(r.kind).toBe("replay");
    if (r.kind === "replay") {
      expect(r.events.map((e) => e.id)).toEqual(["ep:3"]);
    }
  });

  it("resyncs on a malformed last-event-id", () => {
    const bus = new DmEventBus({ epoch: "ep", bufferMax: 10 });
    bus.publish(msg("c1", "m1"));
    expect(bus.replaySince("garbage").kind).toBe("resync");
  });
});

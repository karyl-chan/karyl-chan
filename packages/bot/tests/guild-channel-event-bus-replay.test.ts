import { describe, expect, it } from "vitest";
import {
  GuildChannelEventBus,
  type GuildChannelEvent,
} from "../src/modules/guild-management/guild-channel-event-bus.js";

function msg(guildId: string, channelId: string, id: string): GuildChannelEvent {
  return {
    type: "guild-message-created",
    guildId,
    channelId,
    message: { id },
  } as unknown as GuildChannelEvent;
}
function typing(guildId: string, channelId: string): GuildChannelEvent {
  return {
    type: "guild-typing-start",
    guildId,
    channelId,
    userId: "u",
    userName: "n",
    startedAt: 0,
  };
}

describe("GuildChannelEventBus reconnect replay", () => {
  it("assigns monotonic ids and delivers (event, id) to subscribers", () => {
    const bus = new GuildChannelEventBus({ epoch: "ep", bufferMax: 10 });
    const seen: string[] = [];
    bus.subscribe((_e, id) => seen.push(id));
    bus.publish(msg("g1", "c1", "m1"));
    bus.publish(msg("g1", "c1", "m2"));
    expect(seen).toEqual(["ep:1", "ep:2"]);
    expect(bus.latestId()).toBe("ep:2");
  });

  it("replaySince returns the durable events after the given id", () => {
    const bus = new GuildChannelEventBus({ epoch: "ep", bufferMax: 10 });
    bus.publish(msg("g1", "c1", "m1"));
    bus.publish(msg("g1", "c1", "m2"));
    bus.publish(msg("g1", "c1", "m3"));
    const r = bus.replaySince("ep:1");
    expect(r.kind).toBe("replay");
    if (r.kind === "replay") {
      expect(r.events.map((e) => e.id)).toEqual(["ep:2", "ep:3"]);
    }
  });

  it("reports caughtUp at the head and resyncs on epoch mismatch", () => {
    const bus = new GuildChannelEventBus({ epoch: "ep", bufferMax: 10 });
    bus.publish(msg("g1", "c1", "m1"));
    expect(bus.replaySince("ep:1").kind).toBe("caughtUp");
    expect(bus.replaySince("other:1").kind).toBe("resync");
  });

  it("resyncs only when the gap predates the retained buffer", () => {
    const bus = new GuildChannelEventBus({ epoch: "ep", bufferMax: 2 });
    bus.publish(msg("g1", "c1", "m1")); // ep:1 — evicted
    bus.publish(msg("g1", "c1", "m2")); // ep:2
    bus.publish(msg("g1", "c1", "m3")); // ep:3 → buffer [m2,m3], evicted up to seq 1
    expect(bus.replaySince("ep:1").kind).toBe("replay");
    expect(bus.replaySince("ep:0").kind).toBe("resync");
  });

  it("does not buffer or replay transient typing events", () => {
    const bus = new GuildChannelEventBus({ epoch: "ep", bufferMax: 10 });
    bus.publish(msg("g1", "c1", "m1")); // ep:1
    bus.publish(typing("g1", "c1")); // ep:2 — transient
    bus.publish(msg("g1", "c1", "m2")); // ep:3
    const r = bus.replaySince("ep:1");
    expect(r.kind).toBe("replay");
    if (r.kind === "replay") {
      expect(r.events.map((e) => e.id)).toEqual(["ep:3"]);
    }
  });

  it("resyncs on a malformed last-event-id", () => {
    const bus = new GuildChannelEventBus({ epoch: "ep", bufferMax: 10 });
    bus.publish(msg("g1", "c1", "m1"));
    expect(bus.replaySince("garbage").kind).toBe("resync");
  });
});

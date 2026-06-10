import { EventEmitter } from "events";
import { config } from "../../config.js";
import type { Message } from "../web-core/message-types.js";
import type { DmChannelSummary } from "./dm-inbox.service.js";

export type DmEvent =
  | { type: "message-created"; channelId: string; message: Message }
  | { type: "message-updated"; channelId: string; message: Message }
  | { type: "message-deleted"; channelId: string; messageId: string }
  | { type: "channel-touched"; channel: DmChannelSummary }
  | {
      type: "typing-start";
      channelId: string;
      userId: string;
      userName: string;
      startedAt: number;
    };

/** A published event paired with its monotonic stream id (`<epoch>:<seq>`). */
export interface StampedDmEvent {
  id: string;
  event: DmEvent;
}

/** Listener receives the event and the stream id assigned to it. */
export type DmEventListener = (event: DmEvent, id: string) => void;

/**
 * Result of asking the bus to replay events a reconnecting client missed:
 *  - `replay`: here are the durable events after your last-seen id (possibly
 *    empty if you only missed transient/typing events).
 *  - `caughtUp`: your last-seen id is the current head — nothing missed.
 *  - `resync`: the gap can't be served from the buffer (it predates the
 *    retained window, or the epoch differs = the server restarted). The
 *    client must do a full reload.
 */
export type ReplayResult =
  | { kind: "replay"; events: StampedDmEvent[] }
  | { kind: "caughtUp" }
  | { kind: "resync" };

export class EmitterLimitError extends Error {
  constructor(limit: number) {
    super(`SSE listener limit reached (max ${limit})`);
    this.name = "EmitterLimitError";
  }
}

/** Transient events aren't worth replaying — a stale "X is typing" delivered
 *  seconds after a reconnect is wrong, and the indicator self-expires anyway. */
function isDurable(event: DmEvent): boolean {
  return event.type !== "typing-start";
}

export class DmEventBus {
  private emitter = new EventEmitter();
  private readonly maxListeners: number;
  // Identifies this process's event stream. A restart yields a new epoch, so a
  // client reconnecting with a pre-restart id is told to resync rather than
  // silently losing everything that happened while the bus's seq was reset.
  private readonly epoch: string;
  private seq = 0;
  private readonly buffer: StampedDmEvent[] = [];
  private readonly bufferMax: number;
  // Highest durable seq evicted from the buffer (0 = none). A client whose
  // last-seen seq is below this has lost coverage → resync.
  private evictedMaxSeq = 0;

  constructor(opts?: {
    maxListeners?: number;
    bufferMax?: number;
    epoch?: string;
  }) {
    this.maxListeners = opts?.maxListeners ?? config.dm.sseMaxListeners;
    this.bufferMax = opts?.bufferMax ?? config.dm.sseReplayBufferSize;
    // Date.now() is fine here (server runtime, not a workflow script); base36
    // keeps the id compact. Tests can pin the epoch for determinism.
    this.epoch = opts?.epoch ?? Date.now().toString(36);
    this.emitter.setMaxListeners(this.maxListeners);
  }

  publish(event: DmEvent): void {
    const id = `${this.epoch}:${++this.seq}`;
    if (isDurable(event)) {
      this.buffer.push({ id, event });
      while (this.buffer.length > this.bufferMax) {
        const evicted = this.buffer.shift();
        if (evicted) this.evictedMaxSeq = this.seqOf(evicted.id);
      }
    }
    this.emitter.emit("event", event, id);
  }

  /** Replay durable events a client missed since `lastEventId`. */
  replaySince(lastEventId: string): ReplayResult {
    const sep = lastEventId.lastIndexOf(":");
    if (sep === -1) return { kind: "resync" };
    const epoch = lastEventId.slice(0, sep);
    const lastSeq = Number(lastEventId.slice(sep + 1));
    if (epoch !== this.epoch || !Number.isInteger(lastSeq) || lastSeq < 0) {
      return { kind: "resync" }; // different process, or malformed id
    }
    if (lastSeq >= this.seq) return { kind: "caughtUp" };
    // A durable event the client still needs was already evicted → can't serve.
    if (lastSeq < this.evictedMaxSeq) return { kind: "resync" };
    return {
      kind: "replay",
      events: this.buffer.filter((b) => this.seqOf(b.id) > lastSeq),
    };
  }

  /** The current head id, e.g. to stamp a resync control frame. */
  latestId(): string {
    return `${this.epoch}:${this.seq}`;
  }

  isAtLimit(): boolean {
    return this.emitter.listenerCount("event") >= this.maxListeners;
  }

  subscribe(listener: DmEventListener): () => void {
    const current = this.emitter.listenerCount("event");
    if (current >= this.maxListeners) {
      throw new EmitterLimitError(this.maxListeners);
    }
    this.emitter.on("event", listener);
    return () => this.emitter.off("event", listener);
  }

  private seqOf(id: string): number {
    return Number(id.slice(id.lastIndexOf(":") + 1));
  }
}

export const dmEventBus = new DmEventBus();

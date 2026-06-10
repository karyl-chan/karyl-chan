import { EventEmitter } from "events";
import { config } from "../../config.js";
import type { Message } from "../web-core/message-types.js";

export interface VoiceMember {
  id: string;
  username: string;
  globalName: string | null;
  nickname: string | null;
  avatarUrl: string | null;
}

export type GuildChannelEvent =
  | {
      type: "guild-message-created";
      guildId: string;
      channelId: string;
      message: Message;
    }
  | {
      type: "guild-message-updated";
      guildId: string;
      channelId: string;
      message: Message;
    }
  | {
      type: "guild-message-deleted";
      guildId: string;
      channelId: string;
      messageId: string;
    }
  | {
      type: "guild-typing-start";
      guildId: string;
      channelId: string;
      userId: string;
      userName: string;
      startedAt: number;
    }
  /** Fires when any participant joins, leaves, or moves between voice/stage
   *  channels in the guild. `channels` lists every affected channel's
   *  current participant set so clients can patch in place without
   *  refetching the channel tree. */
  | {
      type: "guild-voice-state-updated";
      guildId: string;
      channels: Array<{ channelId: string; members: VoiceMember[] }>;
    };

/** A published event paired with its monotonic stream id (`<epoch>:<seq>`). */
export interface StampedGuildChannelEvent {
  id: string;
  event: GuildChannelEvent;
}

/** Listener receives the event and the stream id assigned to it. */
export type GuildChannelEventListener = (
  event: GuildChannelEvent,
  id: string,
) => void;

/**
 * Result of asking the bus to replay events a reconnecting client missed:
 *  - `replay`: the durable events after the last-seen id (maybe empty if only
 *    transient events advanced the stream).
 *  - `caughtUp`: the last-seen id is the head — nothing missed.
 *  - `resync`: the gap predates the retained buffer, or the epoch differs (a
 *    restart). The client must do a full reload.
 */
export type GuildReplayResult =
  | { kind: "replay"; events: StampedGuildChannelEvent[] }
  | { kind: "caughtUp" }
  | { kind: "resync" };

export class EmitterLimitError extends Error {
  constructor(limit: number) {
    super(`SSE listener limit reached (max ${limit})`);
    this.name = "EmitterLimitError";
  }
}

/** Only message events are worth replaying. Typing + voice-state are transient
 *  live snapshots — replaying a stale one after a reconnect would mislead. */
function isDurable(event: GuildChannelEvent): boolean {
  return (
    event.type === "guild-message-created" ||
    event.type === "guild-message-updated" ||
    event.type === "guild-message-deleted"
  );
}

export class GuildChannelEventBus {
  private emitter = new EventEmitter();
  private readonly maxListeners: number;
  // Per-process stream identity: a restart yields a new epoch so a client
  // reconnecting with a pre-restart id is told to resync (see DmEventBus).
  private readonly epoch: string;
  private seq = 0;
  private readonly buffer: StampedGuildChannelEvent[] = [];
  private readonly bufferMax: number;
  private evictedMaxSeq = 0;

  constructor(opts?: {
    maxListeners?: number;
    bufferMax?: number;
    epoch?: string;
  }) {
    this.maxListeners = opts?.maxListeners ?? config.dm.sseMaxListeners;
    this.bufferMax = opts?.bufferMax ?? config.dm.sseReplayBufferSize;
    this.epoch = opts?.epoch ?? Date.now().toString(36);
    this.emitter.setMaxListeners(this.maxListeners);
  }

  publish(event: GuildChannelEvent): void {
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
  replaySince(lastEventId: string): GuildReplayResult {
    const sep = lastEventId.lastIndexOf(":");
    if (sep === -1) return { kind: "resync" };
    const epoch = lastEventId.slice(0, sep);
    const lastSeq = Number(lastEventId.slice(sep + 1));
    if (epoch !== this.epoch || !Number.isInteger(lastSeq) || lastSeq < 0) {
      return { kind: "resync" };
    }
    if (lastSeq >= this.seq) return { kind: "caughtUp" };
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

  subscribe(listener: GuildChannelEventListener): () => void {
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

export const guildChannelEventBus = new GuildChannelEventBus();

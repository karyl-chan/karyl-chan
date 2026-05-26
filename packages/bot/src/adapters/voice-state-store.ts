/**
 * VoiceStateStore — read-only view of per-guild voice connection
 * state for cross-shard observability.
 *
 * The voice connection itself (discord.js `VoiceConnection`, ffmpeg
 * child process, audio resource) is inherently bound to the process
 * that opened it — those handles cannot be serialised. What CAN be
 * shared is the *status* (which channel, what's playing, paused
 * flag, etc.) so that:
 *
 *  - admin UI sitting on a non-voice shard can render the right
 *    "now playing" badge;
 *  - a plugin asking `voice.status` on the wrong shard can be
 *    redirected to the shard that owns the connection (Phase 3.3
 *    shard-aware routing).
 *
 * The InProcess default is a thin wrapper over voice-manager's own
 * in-memory state. Phase 1+ swaps in Redis hash with the same
 * key shape, so a multi-shard deployment shares the read side
 * without trying (and failing) to share the underlying
 * VoiceConnection.
 */

export interface VoiceStatusRecord {
  guildId: string;
  channelId: string | null;
  connected: boolean;
  playing: boolean;
  paused: boolean;
  playingUrl: string | null;
  connectionStatus: string | null;
  playerStatus: string | null;
  /** Which shard process owns the underlying VoiceConnection. */
  shardId: number;
  /** Wall-clock last-update time; observers can detect staleness. */
  updatedAt: number;
}

export interface VoiceStateStore {
  /** Write the latest status for a guild (called from voice-manager on every transition). */
  set(record: VoiceStatusRecord): Promise<void> | void;
  /** Read the latest status; `null` if nothing was ever written. */
  get(guildId: string): Promise<VoiceStatusRecord | null> | VoiceStatusRecord | null;
  /** Drop a guild entirely (called when the bot leaves voice in that guild). */
  delete(guildId: string): Promise<void> | void;
}

export class InProcessVoiceStateStore implements VoiceStateStore {
  private readonly store = new Map<string, VoiceStatusRecord>();

  set(record: VoiceStatusRecord): void {
    this.store.set(record.guildId, { ...record, updatedAt: Date.now() });
  }

  get(guildId: string): VoiceStatusRecord | null {
    return this.store.get(guildId) ?? null;
  }

  delete(guildId: string): void {
    this.store.delete(guildId);
  }
}

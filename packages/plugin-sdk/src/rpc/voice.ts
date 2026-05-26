/**
 * Typed Voice RPC namespace.
 *
 * Wraps the bot's `/api/plugin/voice.*` family. The plan calls for
 * voice to be split into its own service in Phase 3.1; this namespace
 * is the seam — when that ships, the SDK swaps the underlying RPC
 * routing without changing this surface, and plugins that already use
 * `ctx.voice.*` see no breakage.
 */

import type { RpcCaller } from "./index.js";

export interface VoiceJoinArgs {
  guildId: string;
  /** Specific voice channel to join. Wins when both fields are set. */
  channelId?: string;
  /** Or hop into whichever VC this member is currently in. */
  userId?: string;
  /** Defaults true on the bot side. */
  selfDeaf?: boolean;
  /** Defaults false on the bot side. */
  selfMute?: boolean;
}

export interface VoicePlayArgs {
  guildId: string;
  url: string;
}

export interface VoicePauseArgs {
  guildId: string;
  /**
   * Omit to toggle. `true` forces pause; `false` forces resume.
   * Bot echoes the resulting paused state.
   */
  paused?: boolean;
}

export interface VoiceStatus {
  connected: boolean;
  channelId: string | null;
  playing: boolean;
  paused: boolean;
  playingUrl: string | null;
  connectionStatus: string | null;
  playerStatus: string | null;
  /** Non-bot listeners in the bot's VC, when known. */
  listeners?: number;
}

export interface Voice {
  join(args: VoiceJoinArgs): Promise<VoiceStatus>;
  leave(guildId: string): Promise<VoiceStatus>;
  play(args: VoicePlayArgs): Promise<VoiceStatus>;
  pause(args: VoicePauseArgs): Promise<{ paused: boolean }>;
  stop(guildId: string): Promise<VoiceStatus>;
  status(guildId: string): Promise<VoiceStatus>;
}

export function createVoice(call: RpcCaller): Voice {
  return {
    async join(args) {
      return (await call("/api/plugin/voice.join", {
        guild_id: args.guildId,
        ...(args.channelId !== undefined ? { channel_id: args.channelId } : {}),
        ...(args.userId !== undefined ? { user_id: args.userId } : {}),
        ...(args.selfDeaf !== undefined ? { self_deaf: args.selfDeaf } : {}),
        ...(args.selfMute !== undefined ? { self_mute: args.selfMute } : {}),
      })) as VoiceStatus;
    },
    async leave(guildId) {
      return (await call("/api/plugin/voice.leave", {
        guild_id: guildId,
      })) as VoiceStatus;
    },
    async play(args) {
      return (await call("/api/plugin/voice.play", {
        guild_id: args.guildId,
        url: args.url,
      })) as VoiceStatus;
    },
    async pause(args) {
      return (await call("/api/plugin/voice.pause", {
        guild_id: args.guildId,
        ...(args.paused !== undefined ? { paused: args.paused } : {}),
      })) as { paused: boolean };
    },
    async stop(guildId) {
      return (await call("/api/plugin/voice.stop", {
        guild_id: guildId,
      })) as VoiceStatus;
    },
    async status(guildId) {
      return (await call("/api/plugin/voice.status", {
        guild_id: guildId,
      })) as VoiceStatus;
    },
  };
}

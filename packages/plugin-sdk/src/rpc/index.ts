/**
 * Typed RPC facade.
 *
 * Plugin authors call `ctx.discord.messages.send(...)` and
 * `ctx.voice.play(...)` instead of `ctx.botRpc("/api/plugin/...")`.
 * The wire path / param naming convention stays an internal SDK
 * detail so the bot can rename, version, or batch RPC routes without
 * forcing every plugin to chase the string.
 *
 * Every namespace wraps a `RpcCaller` — a thin closure that already
 * carries the token + log + retry policy. This module just shapes
 * arguments and parses responses; the auth/retry mechanics live in
 * `server.ts`.
 *
 * `ctx.botRpc(path, body)` remains the supported escape hatch for
 * methods not yet exposed here. We do NOT @deprecate it — it is the
 * documented release valve when the typed facade lags behind a new
 * bot RPC method.
 */

import type { Discord } from "./discord.js";
import type { Voice } from "./voice.js";
import { createDiscord } from "./discord.js";
import { createVoice } from "./voice.js";

export type RpcCaller = (path: string, body?: unknown) => Promise<unknown>;

export interface PluginRpc {
  discord: Discord;
  voice: Voice;
}

export function createPluginRpc(call: RpcCaller): PluginRpc {
  return {
    discord: createDiscord(call),
    voice: createVoice(call),
  };
}

export type { Discord } from "./discord.js";
export type {
  DiscordMessages,
  DiscordMembers,
  DiscordInteractions,
  MessageSendArgs,
  MessageEditArgs,
  MessageDeleteArgs,
  MessageAddReactionArgs,
  MessageHandle,
  MemberGetArgs,
  MemberSummary,
  InteractionRespondArgs,
  InteractionFollowupArgs,
} from "./discord.js";
export type {
  Voice,
  VoiceJoinArgs,
  VoicePlayArgs,
  VoicePauseArgs,
  VoiceStatus,
} from "./voice.js";

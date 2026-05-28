/**
 * Typed RPC facade.
 *
 * Plugin authors call `ctx.discord.messages.send(...)`,
 * `ctx.kv.guild(g).set(...)`, `ctx.me.enabledGuilds()`,
 * `ctx.voice.play(...)`, `ctx.auth.mintSession(...)` instead of
 * `ctx.botRpc("/api/plugin/...")`. The wire path / param naming
 * convention stays an internal SDK detail so the bot can rename,
 * version, or batch RPC routes without forcing every plugin to chase
 * the string.
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
import type { Me } from "./me.js";
import type { Kv } from "./kv.js";
import type { Auth } from "./auth.js";
import { createDiscord } from "./discord.js";
import { createVoice } from "./voice.js";
import { createMe } from "./me.js";
import { createKv } from "./kv.js";
import { createAuth } from "./auth.js";

export type RpcCaller = (path: string, body?: unknown) => Promise<unknown>;

export interface PluginRpc {
  discord: Discord;
  voice: Voice;
  me: Me;
  kv: Kv;
  auth: Auth;
}

export function createPluginRpc(call: RpcCaller): PluginRpc {
  return {
    discord: createDiscord(call),
    voice: createVoice(call),
    me: createMe(call),
    kv: createKv(call),
    auth: createAuth(call),
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
export type { Me, MeKvUsageArgs, MeKvUsage } from "./me.js";
export type {
  Kv,
  GuildKv,
  KvListOptions,
  KvEntry,
  KvSetResult,
  KvIncrementResult,
} from "./kv.js";
export { KV_KEY_MAX, KV_VALUE_MAX_BYTES } from "./kv.js";
export type {
  Auth,
  SessionKind,
  MintSessionArgs,
  MintSessionResult,
} from "./auth.js";

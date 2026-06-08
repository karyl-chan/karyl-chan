/**
 * VoiceBackend — the seam that lets voice run in-process (single-machine
 * default) OR in a standalone voice service (PR-2.3 full split).
 *
 * Why a seam, and why now: the plugin RPC + slash commands must not care
 * WHERE the VoiceConnection + ffmpeg live. The hard part of splitting voice
 * out is that @discordjs/voice's `DiscordGatewayAdapterCreator` is a live
 * closure over the bot's gateway shard — it CANNOT cross an HTTP boundary.
 * So the backend interface deliberately does NOT take an adapterCreator:
 * each backend obtains its own. The in-process backend reads
 * `guild.voiceAdapterCreator` off the bot Client; the future remote backend
 * builds a bridge adapter that tunnels gateway payloads to the bot over
 * HTTP (see docs/VOICE_SPLIT_DESIGN.md).
 *
 * Single-machine simplicity is preserved: with no VOICE_SERVICE_URL the
 * in-process backend is used and behaviour is byte-for-byte the same as
 * before — zero new dependencies, no extra process.
 *
 * This mirrors the SCALING_PLAN adapter pattern (in-process default +
 * external impl chosen by env), like the session / event-bus / lock
 * adapters already in src/adapters/.
 */

import type { Client } from "discord.js";
import {
  joinVoice,
  leaveVoice,
  playUrl,
  pausePlayback,
  stopPlayback,
  getStatus,
  shutdownAllVoice,
  setVoiceLogger,
  VoiceCapacityError,
  type VoiceStatus,
} from "@karyl-chan/voice";
import { moduleLogger } from "../../logger.js";
import { RemoteVoiceBackend } from "./remote-voice-backend.js";
import { getSecret } from "../../utils/secrets.js";

// Route the relocated voice manager's structured logs through the bot's pino
// logger so in-process voice logging is byte-for-byte what it was before the
// manager moved to @karyl-chan/voice. (The standalone service uses the
// manager's default console sink.)
setVoiceLogger(moduleLogger("voice-manager"));

export interface VoiceJoinRequest {
  guildId: string;
  channelId: string;
  selfDeaf?: boolean;
  selfMute?: boolean;
}

/**
 * Transport-agnostic voice control surface. All methods are async so a
 * remote (HTTP) backend fits the same shape as the in-process one.
 *
 * `join` may throw VoiceCapacityError — the RPC layer maps it to HTTP 429.
 * A remote backend re-throws the same error type when the service replies
 * 429, so callers branch identically regardless of backend.
 */
export interface VoiceBackend {
  join(req: VoiceJoinRequest): Promise<VoiceStatus>;
  leave(guildId: string): Promise<VoiceStatus>;
  play(guildId: string, url: string): Promise<VoiceStatus>;
  pause(guildId: string, paused?: boolean): Promise<VoiceStatus>;
  stop(guildId: string): Promise<VoiceStatus>;
  status(guildId: string): Promise<VoiceStatus>;
  /** Tear down all connections (graceful shutdown). */
  shutdown(): Promise<void>;
}

/**
 * In-process backend: the VoiceConnection + ffmpeg live in this process,
 * exactly as before. Obtains the gateway adapter from the bot Client per
 * guild — which is why it needs a Client accessor.
 */
export class InProcessVoiceBackend implements VoiceBackend {
  // A lazy accessor (not the Client directly) so wiring order at boot
  // doesn't matter — the Client is set once `ready`, the backend is built
  // earlier. Mirrors the getBot() closure pattern used elsewhere.
  constructor(private readonly getClient: () => Client | null) {}

  async join(req: VoiceJoinRequest): Promise<VoiceStatus> {
    const client = this.getClient();
    if (!client) throw new Error("bot client unavailable");
    // voiceAdapterCreator is a closure over this guild's gateway shard.
    // Prefer the cache (the RPC layer already validated+cached the guild)
    // and only hit the REST API on a cache miss.
    const guild =
      client.guilds.cache.get(req.guildId) ??
      (await client.guilds.fetch(req.guildId));
    return joinVoice({
      guildId: req.guildId,
      channelId: req.channelId,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: req.selfDeaf,
      selfMute: req.selfMute,
    });
  }

  async leave(guildId: string): Promise<VoiceStatus> {
    return leaveVoice(guildId);
  }

  async play(guildId: string, url: string): Promise<VoiceStatus> {
    return playUrl(guildId, url);
  }

  async pause(guildId: string, paused?: boolean): Promise<VoiceStatus> {
    return pausePlayback(guildId, paused);
  }

  async stop(guildId: string): Promise<VoiceStatus> {
    return stopPlayback(guildId);
  }

  async status(guildId: string): Promise<VoiceStatus> {
    return getStatus(guildId);
  }

  async shutdown(): Promise<void> {
    shutdownAllVoice();
  }
}

// Registry — chooses the backend once, like src/adapters/registry.ts.
// VOICE_SERVICE_URL (unset by default) will select the remote backend in a
// follow-up segment; today only the in-process backend exists, so the env
// is read but the remote branch is a documented TODO rather than a silent
// half-implementation.
let backend: VoiceBackend | null = null;
let clientAccessor: () => Client | null = () => null;

/** Wire the bot Client into the in-process backend (called at boot, like
 *  setMetricsBotClient). No-op for a future remote backend. */
export function setVoiceClient(getClient: () => Client | null): void {
  clientAccessor = getClient;
}

export function getVoiceBackend(): VoiceBackend {
  if (backend) return backend;
  const remoteUrl = (process.env.VOICE_SERVICE_URL ?? "").trim();
  if (remoteUrl) {
    // Full split (PR-2.3d): drive the standalone voice service over HTTP.
    // The shared HMAC secret is mandatory — an unauthenticated control
    // channel to a process that owns ffmpeg + the gateway is a footgun, so
    // fail loud rather than silently run unsigned.
    // Outbound signing uses the *current* value from the SecretProvider.
    const secret = getSecret("VOICE_HMAC_SECRET") ?? "";
    if (!secret) {
      throw new Error(
        "VOICE_SERVICE_URL is set but VOICE_HMAC_SECRET is missing — the " +
          "bot↔voice-service channel must be signed. Set VOICE_HMAC_SECRET " +
          "(same value on the voice service) or unset VOICE_SERVICE_URL.",
      );
    }
    backend = new RemoteVoiceBackend({ serviceUrl: remoteUrl, secret });
    return backend;
  }
  backend = new InProcessVoiceBackend(clientAccessor);
  return backend;
}

/** Test seam: reset the memoised backend + client accessor. */
export function resetVoiceBackendForTest(): void {
  backend = null;
  clientAccessor = () => null;
}

export { VoiceCapacityError, type VoiceStatus };

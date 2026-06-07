/**
 * RemoteVoiceBackend (PR-2.3d) — VoiceBackend implementation that drives the
 * standalone voice service over HTTP.
 *
 * Selected by `getVoiceBackend()` when `VOICE_SERVICE_URL` is set. Every call
 * is a signed POST to the service's `/internal/voice/{join,play,…}` using the
 * shared bot↔voice HMAC scheme (the same `buildOutboundSignatureHeaders` the
 * bot uses for plugin dispatch, keyed by `VOICE_HMAC_SECRET`). The service's
 * `429` (capacity cap hit) is re-thrown as `VoiceCapacityError` so callers
 * branch identically regardless of backend.
 *
 * The reverse channel (the service's bridge adapter pushing OP4 payloads back,
 * and the bot relaying gateway events to the service) is wired separately in
 * voice-internal-routes.ts + the bot.on("raw") relay in main.ts — this class
 * is only the control-plane client.
 */
import { signedJsonPost } from "../../utils/hmac.js";
import { moduleLogger } from "../../logger.js";
import type {
  VoiceBackend,
  VoiceJoinRequest,
} from "./voice-backend.js";
import { VoiceCapacityError, type VoiceStatus } from "@karyl-chan/voice";

const log = moduleLogger("remote-voice-backend");

export class RemoteVoiceBackend implements VoiceBackend {
  private readonly base: string;
  private readonly secret: string;

  constructor(opts: { serviceUrl: string; secret: string }) {
    this.base = opts.serviceUrl.replace(/\/+$/, "");
    this.secret = opts.secret;
  }

  private async call(path: string, body: unknown): Promise<VoiceStatus> {
    const res = await signedJsonPost(this.secret, this.base, path, body);
    if (res.status === 429) {
      // Drain the body so the connection can be reused, then surface the cap.
      const detail = await res.text().catch(() => "");
      throw new VoiceCapacityError(
        detail || "voice capacity reached (remote voice service)",
      );
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(
        `remote voice ${path} failed: ${res.status} ${detail}`.trim(),
      );
    }
    return (await res.json()) as VoiceStatus;
  }

  async join(req: VoiceJoinRequest): Promise<VoiceStatus> {
    return this.call("/internal/voice/join", {
      guildId: req.guildId,
      channelId: req.channelId,
      selfDeaf: req.selfDeaf,
      selfMute: req.selfMute,
    });
  }

  async leave(guildId: string): Promise<VoiceStatus> {
    return this.call("/internal/voice/leave", { guildId });
  }

  async play(guildId: string, url: string): Promise<VoiceStatus> {
    return this.call("/internal/voice/play", { guildId, url });
  }

  async pause(guildId: string, paused?: boolean): Promise<VoiceStatus> {
    return this.call("/internal/voice/pause", { guildId, paused });
  }

  async stop(guildId: string): Promise<VoiceStatus> {
    return this.call("/internal/voice/stop", { guildId });
  }

  async status(guildId: string): Promise<VoiceStatus> {
    return this.call("/internal/voice/status", { guildId });
  }

  async shutdown(): Promise<void> {
    // The voice service owns its own connection lifecycle and tears them down
    // on its own SIGTERM. The bot shutting down does not (and must not) drop
    // the remote service's connections — they may serve other shards.
    log.info({}, "remote voice backend shutdown: no-op (service-owned lifecycle)");
  }
}

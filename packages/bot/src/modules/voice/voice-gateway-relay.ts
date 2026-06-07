/**
 * Bot → voice-service gateway-event relay (PR-2.3d).
 *
 * The standalone voice service owns the VoiceConnection but not the gateway
 * WebSocket, so its bridge adapter needs the two voice gateway events that the
 * bot's shard receives. This module hooks the bot's `raw` gateway stream and
 * forwards them to the service's `/internal/voice/gateway-event` (signed).
 *
 * Relay rules (correctness — these are the crux of the inbound bridge):
 *  - VOICE_SERVER_UPDATE: always relay `d` (carries the voice endpoint + token
 *    the service needs to open the UDP voice connection).
 *  - VOICE_STATE_UPDATE: relay `d` ONLY when `d.user_id === bot.user.id` — the
 *    @discordjs/voice adapter only cares about the BOT's own voice state, not
 *    every member moving channels (which would be a firehose).
 *  - Both gated on the guild having an active remote connection
 *    (`activeRemoteGuilds`), so we don't forward events for guilds the service
 *    isn't handling.
 *
 * No-op unless VOICE_SERVICE_URL + VOICE_HMAC_SECRET are configured — the
 * single-machine default never installs the hook.
 */
import type { Client } from "discord.js";
import { signedJsonPost } from "../../utils/hmac.js";
import { moduleLogger } from "../../logger.js";
import { activeRemoteGuilds } from "./voice-internal-routes.js";

const log = moduleLogger("voice-gateway-relay");

const GATEWAY_EVENT_PATH = "/internal/voice/gateway-event";

interface RawVoicePacket {
  t?: string;
  d?: { guild_id?: string | null; user_id?: string };
}

async function relayEvent(
  base: string,
  secret: string,
  guildId: string,
  type: "VOICE_STATE_UPDATE" | "VOICE_SERVER_UPDATE",
  data: unknown,
): Promise<void> {
  try {
    const res = await signedJsonPost(secret, base, GATEWAY_EVENT_PATH, {
      guildId,
      type,
      data,
    });
    if (!res.ok) {
      log.warn({ guildId, type, status: res.status }, "gateway-event relay rejected");
    }
  } catch (err) {
    log.error({ err, guildId, type }, "gateway-event relay failed");
  }
}

/**
 * Install the relay on the bot client. Returns immediately (no-op) when the
 * split isn't configured. Safe to call once at boot.
 */
export function installVoiceGatewayRelay(bot: Client): void {
  const serviceUrl = (process.env.VOICE_SERVICE_URL ?? "").trim();
  const secret = (process.env.VOICE_HMAC_SECRET ?? "").trim();
  if (!serviceUrl || !secret) return;
  const base = serviceUrl.replace(/\/+$/, "");
  log.info({ serviceUrl: base }, "voice gateway relay installed");

  bot.on("raw", (packet: RawVoicePacket) => {
    const t = packet.t;
    if (t !== "VOICE_STATE_UPDATE" && t !== "VOICE_SERVER_UPDATE") return;
    const guildId = packet.d?.guild_id;
    if (!guildId) return;
    // Only relay for guilds the remote service actually holds a connection for.
    if (!activeRemoteGuilds.has(guildId)) return;
    if (t === "VOICE_STATE_UPDATE") {
      // The adapter only wants the bot's own voice state.
      if (packet.d?.user_id !== bot.user?.id) return;
    }
    void relayEvent(base, secret, guildId, t, packet.d);
  });
}

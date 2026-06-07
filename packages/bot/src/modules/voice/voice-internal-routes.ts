/**
 * Bot-side internal voice routes (PR-2.3d) — the reverse channel from the
 * standalone voice service back to the bot.
 *
 * The voice service owns the VoiceConnection but not the gateway WebSocket, so
 * its bridge adapter tunnels two things to the bot:
 *   POST /internal/voice/gateway-send    {guildId, payload}
 *       → the bot emits the OP4 payload over the shard that owns `guildId`
 *         (`guild.shard.send(payload)`), and marks the guild as having an
 *         active remote connection so the raw-event relay starts forwarding.
 *   POST /internal/voice/gateway-destroy {guildId}
 *       → the connection was torn down; stop relaying for that guild.
 *
 * Both are HMAC-verified with the shared VOICE_HMAC_SECRET. They're registered
 * inside an encapsulated Fastify plugin with a raw-string body parser so the
 * signature can be checked against the exact bytes on the wire (the bot's
 * default JSON parser would re-stringify and break verification).
 *
 * `activeRemoteGuilds` is the gate the bot.on("raw") relay reads: a guild is
 * added on the first gateway-send (the join handshake's OP4) and removed on
 * gateway-destroy, so the relay only forwards events for guilds the remote
 * service actually has a live connection for.
 */
import type { Client } from "discord.js";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { verifyInboundSignatureFromHeadersWithKeys } from "../../utils/hmac.js";
import { moduleLogger } from "../../logger.js";

const log = moduleLogger("voice-internal-routes");

/**
 * Guilds with a live remote voice connection. The raw-event relay forwards
 * VOICE_STATE_UPDATE (bot's own) + VOICE_SERVER_UPDATE only for these. Module-
 * level so both this file and the main.ts relay share one set.
 */
export const activeRemoteGuilds = new Set<string>();

/** Test seam. */
export function resetActiveRemoteGuildsForTest(): void {
  activeRemoteGuilds.clear();
}

export interface VoiceInternalRoutesOptions {
  bot?: Client;
  /**
   * Verification keys for the shared bot↔voice HMAC secret, sourced from
   * the SecretProvider: `[current]`, or `[current, previous]` during a
   * rotation window. Empty array ⇒ routes 503 everything (misconfig
   * guard / no shared secret configured).
   */
  secrets: readonly string[];
}

export async function registerVoiceInternalRoutes(
  server: FastifyInstance,
  options: VoiceInternalRoutesOptions,
): Promise<void> {
  const { bot, secrets } = options;

  // Encapsulated scope so the raw-string parser doesn't affect the rest of
  // the bot's API (which relies on Fastify's default JSON object parsing).
  await server.register(async (scoped) => {
    scoped.addContentTypeParser(
      "application/json",
      { parseAs: "string" },
      (_req, body, done) => done(null, body),
    );

    function verify(request: FastifyRequest, reply: FastifyReply): boolean {
      if (secrets.length === 0) {
        reply.code(503).send({ error: "voice HMAC secret not configured" });
        return false;
      }
      const rawBody = typeof request.body === "string" ? request.body : "";
      const check = verifyInboundSignatureFromHeadersWithKeys(
        secrets,
        request.headers,
        rawBody,
        Math.floor(Date.now() / 1000),
        request.method,
        request.url.split("?")[0] ?? request.url,
      );
      if (!check.ok) {
        reply.code(401).send({ error: check.reason });
        return false;
      }
      return true;
    }

    function parse<T>(request: FastifyRequest): T {
      const raw = typeof request.body === "string" ? request.body : "{}";
      return JSON.parse(raw) as T;
    }

    // OP4 payload from the voice service → emit over the owning shard.
    scoped.post("/internal/voice/gateway-send", async (request, reply) => {
      if (!verify(request, reply)) return;
      const body = parse<{ guildId?: unknown; payload?: unknown }>(request);
      if (typeof body.guildId !== "string" || body.guildId.length === 0) {
        return reply.code(400).send({ error: "guildId required" });
      }
      if (body.payload == null || typeof body.payload !== "object") {
        return reply.code(400).send({ error: "payload required" });
      }
      if (!bot) {
        return reply.code(503).send({ error: "bot client unavailable" });
      }
      const guild = bot.guilds.cache.get(body.guildId);
      if (!guild) {
        // The bot doesn't (yet) know this guild — can't resolve the shard.
        // The service will retry on the next handshake step.
        return reply.code(404).send({ error: "guild not found on this bot" });
      }
      try {
        // guild.shard.send dispatches the raw OP4 over the WebSocket of the
        // shard that owns this guild — correct even in multi-shard.
        guild.shard.send(body.payload);
      } catch (err) {
        log.error({ err, guildId: body.guildId }, "gateway-send failed");
        return reply.code(502).send({ error: "failed to send over gateway" });
      }
      // First OP4 for this guild ⇒ the remote connection is live; start
      // relaying its gateway events.
      activeRemoteGuilds.add(body.guildId);
      return { sent: true };
    });

    // Connection destroyed on the service → stop relaying for this guild.
    scoped.post("/internal/voice/gateway-destroy", async (request, reply) => {
      if (!verify(request, reply)) return;
      const body = parse<{ guildId?: unknown }>(request);
      if (typeof body.guildId !== "string" || body.guildId.length === 0) {
        return reply.code(400).send({ error: "guildId required" });
      }
      activeRemoteGuilds.delete(body.guildId);
      return { ok: true };
    });
  });
}

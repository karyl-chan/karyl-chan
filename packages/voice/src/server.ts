/**
 * Voice service HTTP API (PR-2.3c).
 *
 * Exposes the bot→voice-service control + event-relay channel, all HMAC-
 * verified with the shared secret:
 *   POST /internal/voice/join    {guildId, channelId, selfDeaf?, selfMute?}
 *   POST /internal/voice/play    {guildId, url}
 *   POST /internal/voice/leave   {guildId}
 *   POST /internal/voice/pause   {guildId, paused?}
 *   POST /internal/voice/stop    {guildId}
 *   POST /internal/voice/status  {guildId}
 *   POST /internal/voice/gateway-event {guildId, type, data}
 *
 * Each guild is joined through a GatewayBridge adapter whose sendPayload is
 * tunneled to the bot's /internal/voice/gateway-send, and whose inbound
 * gateway events arrive via /internal/voice/gateway-event. The admission-
 * control cap lives in the manager, so a join over capacity returns 429
 * (VoiceCapacityError) — matching the in-process backend's contract.
 *
 * `/health` is unauthenticated (liveness probe). Everything under
 * `/internal/voice/` requires a valid signature + fresh timestamp.
 */
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { verifyDispatchHmac } from "@karyl-chan/plugin-sdk";
import {
  joinVoice,
  leaveVoice,
  playUrl,
  pausePlayback,
  stopPlayback,
  getStatus,
  VoiceCapacityError,
} from "./voice-manager.js";
import { GatewayBridge, type GatewayEventType } from "./gateway-bridge.js";
import { createBotClient, type BotClient } from "./bot-client.js";

export interface VoiceServerOptions {
  hmacSecret: string;
  botInternalUrl: string;
  /** Override the bot client (tests inject a fake instead of real HTTP). */
  botClient?: BotClient;
  /** Override the bridge (tests). Defaults to one wired to the bot client. */
  bridge?: GatewayBridge;
  logger?: boolean;
}

/** Build (but don't listen on) the Fastify app — handy for tests. */
export function buildServer(opts: VoiceServerOptions): {
  server: FastifyInstance;
  bridge: GatewayBridge;
} {
  const server = Fastify({ logger: opts.logger ?? false });

  const botClient =
    opts.botClient ??
    createBotClient({ baseUrl: opts.botInternalUrl, secret: opts.hmacSecret });

  // The bridge's transport tunnels to the bot. sendPayload is synchronous +
  // boolean per the @discordjs/voice adapter contract, but the POST to the
  // bot is async — return true optimistically (the OP4 is on its way) and log
  // any delivery failure out-of-band. A `false` would make @discordjs/voice
  // disconnect immediately on a transient network blip, which is worse than a
  // retry on the next handshake step.
  const bridge =
    opts.bridge ??
    new GatewayBridge({
      sendPayload(guildId, payload) {
        botClient
          .post("/internal/voice/gateway-send", { guildId, payload })
          .then((status) => {
            if (status >= 400) {
              server.log.warn(
                { guildId, status },
                "gateway-send rejected by bot",
              );
            }
          })
          .catch((err: unknown) => {
            server.log.error({ err, guildId }, "gateway-send to bot failed");
          });
        return true;
      },
      onDestroy(guildId) {
        botClient
          .post("/internal/voice/gateway-destroy", { guildId })
          .catch((err: unknown) => {
            server.log.error(
              { err, guildId },
              "gateway-destroy notice to bot failed",
            );
          });
      },
    });

  // Raw-body parser so HMAC verification hashes the exact bytes on the wire
  // (JSON-parse-then-re-stringify would not verify).
  server.addContentTypeParser(
    "application/json",
    { parseAs: "string" },
    (_req, body, done) => done(null, body),
  );

  server.get("/health", async () => ({ status: "ok" }));

  // HMAC is verified per route via `requireHmac` (not an onRequest hook) so it
  // can hash the raw body, which Fastify only makes available after parsing.
  function requireHmac(request: FastifyRequest, reply: FastifyReply): boolean {
    const rawBody = typeof request.body === "string" ? request.body : "";
    const check = verifyDispatchHmac({
      secret: opts.hmacSecret,
      method: request.method,
      // Path must match what the caller signed: pathname only, no query.
      path: request.url.split("?")[0] ?? request.url,
      body: rawBody,
      headers: request.headers as Record<string, string | string[] | undefined>,
    });
    if (!check.ok) {
      reply.code(401).send({ error: check.reason });
      return false;
    }
    return true;
  }

  function parseBody<T>(request: FastifyRequest): T {
    const raw = typeof request.body === "string" ? request.body : "{}";
    return JSON.parse(raw) as T;
  }

  type GuildBody = { guildId?: unknown };

  function requireGuildId(
    request: FastifyRequest,
    reply: FastifyReply,
  ): string | null {
    const body = parseBody<GuildBody>(request);
    if (typeof body.guildId !== "string" || body.guildId.length === 0) {
      reply.code(400).send({ error: "guildId required" });
      return null;
    }
    return body.guildId;
  }

  server.post("/internal/voice/join", async (request, reply) => {
    if (!requireHmac(request, reply)) return;
    const body = parseBody<{
      guildId?: unknown;
      channelId?: unknown;
      selfDeaf?: unknown;
      selfMute?: unknown;
    }>(request);
    if (typeof body.guildId !== "string" || body.guildId.length === 0) {
      return reply.code(400).send({ error: "guildId required" });
    }
    if (typeof body.channelId !== "string" || body.channelId.length === 0) {
      return reply.code(400).send({ error: "channelId required" });
    }
    try {
      const status = await joinVoice({
        guildId: body.guildId,
        channelId: body.channelId,
        adapterCreator: bridge.adapterCreatorFor(body.guildId),
        selfDeaf: typeof body.selfDeaf === "boolean" ? body.selfDeaf : undefined,
        selfMute: typeof body.selfMute === "boolean" ? body.selfMute : undefined,
      });
      return status;
    } catch (err) {
      if (err instanceof VoiceCapacityError) {
        return reply
          .code(429)
          .send({ error: "voice capacity reached", message: err.message });
      }
      throw err;
    }
  });

  server.post("/internal/voice/play", async (request, reply) => {
    if (!requireHmac(request, reply)) return;
    const body = parseBody<{ guildId?: unknown; url?: unknown }>(request);
    if (typeof body.guildId !== "string" || body.guildId.length === 0) {
      return reply.code(400).send({ error: "guildId required" });
    }
    if (typeof body.url !== "string" || body.url.length === 0) {
      return reply.code(400).send({ error: "url required" });
    }
    try {
      return playUrl(body.guildId, body.url);
    } catch (err) {
      if (err instanceof Error && err.message === "not_joined") {
        return reply
          .code(409)
          .send({ error: "bot not joined to a voice channel in that guild" });
      }
      throw err;
    }
  });

  server.post("/internal/voice/leave", async (request, reply) => {
    if (!requireHmac(request, reply)) return;
    const guildId = requireGuildId(request, reply);
    if (!guildId) return;
    return leaveVoice(guildId);
  });

  server.post("/internal/voice/pause", async (request, reply) => {
    if (!requireHmac(request, reply)) return;
    const body = parseBody<{ guildId?: unknown; paused?: unknown }>(request);
    if (typeof body.guildId !== "string" || body.guildId.length === 0) {
      return reply.code(400).send({ error: "guildId required" });
    }
    const paused = typeof body.paused === "boolean" ? body.paused : undefined;
    return pausePlayback(body.guildId, paused);
  });

  server.post("/internal/voice/stop", async (request, reply) => {
    if (!requireHmac(request, reply)) return;
    const guildId = requireGuildId(request, reply);
    if (!guildId) return;
    return stopPlayback(guildId);
  });

  server.post("/internal/voice/status", async (request, reply) => {
    if (!requireHmac(request, reply)) return;
    const guildId = requireGuildId(request, reply);
    if (!guildId) return;
    return getStatus(guildId);
  });

  // Inbound gateway-event relay from the bot → routed to the guild's adapter.
  server.post("/internal/voice/gateway-event", async (request, reply) => {
    if (!requireHmac(request, reply)) return;
    const body = parseBody<{
      guildId?: unknown;
      type?: unknown;
      data?: unknown;
    }>(request);
    if (typeof body.guildId !== "string" || body.guildId.length === 0) {
      return reply.code(400).send({ error: "guildId required" });
    }
    if (
      body.type !== "VOICE_STATE_UPDATE" &&
      body.type !== "VOICE_SERVER_UPDATE"
    ) {
      return reply.code(400).send({ error: "type must be a voice gateway event" });
    }
    const routed = bridge.dispatchGatewayEvent(
      body.guildId,
      body.type as GatewayEventType,
      body.data,
    );
    // 200 either way — an unknown guild (connection already torn down) is a
    // benign race, not an error the bot should retry on.
    return { routed };
  });

  return { server, bridge };
}

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { config } from "../../config.js";
import { moduleLogger } from "../../logger.js";
import {
  decideForward,
  forwardToShard,
  verifyInboundShardRequest,
} from "../../utils/shard-forward.js";

const log = moduleLogger("shard-forward");

/**
 * Inbound side of cross-shard forwarding (PR-3.3).
 *
 * The shard that OWNS a guild exposes a single signed relay endpoint,
 * `POST /internal/shard/replay`. A sibling shard that received a
 * guild-scoped plugin RPC for a guild it doesn't own signs + POSTs the
 * original request here (see `maybeForwardGuildRpc`); this handler
 * verifies the HMAC, then re-injects the original `/api/plugin/<verb>`
 * request into THIS shard's Fastify instance via `server.inject`,
 * carrying the original plugin Authorization header so the normal RPC
 * handler runs with full auth — and now the guild IS local, so the op
 * succeeds.
 *
 * Replaying through `server.inject` (rather than re-implementing each
 * handler) means every guild-keyed RPC is forwardable with zero
 * per-handler code, and the owning shard runs exactly the same auth +
 * scope + feature-gate + SSRF checks it would for a direct call.
 *
 * The replay body is the original op's body verbatim. The replayed
 * request is marked with an `x-karyl-shard-replayed` header so the
 * forward guard on the owning shard never re-forwards it (loop guard).
 */

export const SHARD_REPLAY_PATH = "/internal/shard/replay";
/** Header set on a replayed request so the forward guard skips it. */
export const SHARD_REPLAYED_HEADER = "x-karyl-shard-replayed";

/**
 * Outbound forward guard for a guild-scoped RPC handler (PR-3.3).
 *
 * Call this at the TOP of a guild-keyed handler, right after the
 * guild_id is known and validated. Behaviour:
 *
 *  - single-shard / this shard owns the guild / already a replay → returns
 *    `{ handled: false }`; the handler proceeds with its normal local path.
 *  - another shard owns the guild AND a SHARD_URLS target + secret exist →
 *    signs + relays the original request to the owning shard, writes that
 *    shard's status+body onto `reply`, and returns `{ handled: true }`; the
 *    caller must `return` immediately.
 *  - owner unreachable / no target configured → returns `{ handled: false }`
 *    so the caller falls through to its existing "guild not found" path
 *    (graceful degradation — never strands the request).
 *
 * The signature covers the request body bytes; we relay the ORIGINAL
 * parsed body (re-serialised) plus the plugin's Authorization header so
 * the owning shard re-runs the full auth + scope checks.
 */
export async function maybeForwardGuildRpc(
  request: FastifyRequest,
  reply: FastifyReply,
  guildId: string,
): Promise<{ handled: boolean }> {
  // Loop guard: a request already replayed onto its owning shard must
  // never be re-forwarded.
  if (request.headers[SHARD_REPLAYED_HEADER]) return { handled: false };

  const decision = decideForward(guildId);
  if (!decision.forward) return { handled: false };

  const secret = config.shard.hmacSecret;
  if (!secret) return { handled: false };

  const authorization = request.headers.authorization;
  if (typeof authorization !== "string" || authorization.length === 0) {
    // No bearer to relay — let the local path 401 as it would have.
    return { handled: false };
  }

  const originalPath = request.url.split("?")[0] ?? request.url;
  try {
    const result = await forwardToShard(decision, secret, SHARD_REPLAY_PATH, {
      path: originalPath,
      body: request.body ?? {},
      authorization,
    });
    reply.code(result.status).send(result.body);
    log.debug(
      { guildId, ownerShard: decision.shardId, path: originalPath, status: result.status },
      "forwarded guild RPC to owning shard",
    );
    return { handled: true };
  } catch (err) {
    // Owning shard unreachable. Fall through to the local path so the
    // caller produces its normal "guild not found" rather than a hard
    // 502 — the plugin can retry, and a transient sibling outage doesn't
    // become a new failure mode.
    log.warn(
      { err, guildId, ownerShard: decision.shardId },
      "cross-shard forward failed; falling back to local path",
    );
    return { handled: false };
  }
}

interface ReplayEnvelope {
  /** Original RPC path, e.g. "/api/plugin/voice.play". */
  path?: unknown;
  /** Original request body (already-parsed JSON object). */
  body?: unknown;
  /** Original plugin bearer Authorization header value. */
  authorization?: unknown;
}

export interface ShardForwardRoutesOptions {
  /** Shared HMAC secret; absent → relay 503s everything (misconfig guard). */
  secret: string | null;
}

export async function registerShardForwardRoutes(
  server: FastifyInstance,
  options: ShardForwardRoutesOptions,
): Promise<void> {
  const { secret } = options;

  // Encapsulated scope with a raw-string JSON parser so the HMAC is
  // verified over the exact received bytes (mirrors the voice internal
  // routes' pattern — the signature covers the raw body, not a
  // re-serialised object).
  await server.register(async (scoped) => {
    scoped.addContentTypeParser(
      "application/json",
      { parseAs: "string" },
      (_req, body, done) => done(null, body),
    );

    function verify(request: FastifyRequest, reply: FastifyReply): boolean {
      if (!secret) {
        reply.code(503).send({ error: "shard HMAC secret not configured" });
        return false;
      }
      const rawBody = typeof request.body === "string" ? request.body : "";
      const check = verifyInboundShardRequest(
        secret,
        request.headers,
        rawBody,
        request.method,
        request.url.split("?")[0] ?? request.url,
      );
      if (!check.ok) {
        reply.code(401).send({ error: check.reason });
        return false;
      }
      return true;
    }

    scoped.post(SHARD_REPLAY_PATH, async (request, reply) => {
      if (!verify(request, reply)) return;
      let env: ReplayEnvelope;
      try {
        env = JSON.parse(
          typeof request.body === "string" ? request.body : "{}",
        ) as ReplayEnvelope;
      } catch {
        return reply.code(400).send({ error: "malformed replay envelope" });
      }
      if (typeof env.path !== "string" || !env.path.startsWith("/api/plugin/")) {
        return reply.code(400).send({ error: "invalid replay path" });
      }
      if (typeof env.authorization !== "string" || env.authorization.length === 0) {
        return reply.code(400).send({ error: "missing replay authorization" });
      }

      // Re-inject the original RPC into THIS shard. The owning shard's
      // normal /api/plugin/<verb> handler runs with the original plugin
      // auth; the guild is local here so the op resolves. The replayed
      // header makes the forward guard treat it as terminal.
      try {
        const injected = await server.inject({
          method: "POST",
          url: env.path,
          headers: {
            authorization: env.authorization,
            "content-type": "application/json",
            [SHARD_REPLAYED_HEADER]: "1",
          },
          payload: JSON.stringify(env.body ?? {}),
        });
        reply
          .code(injected.statusCode)
          .header("content-type", injected.headers["content-type"] ?? "application/json")
          .send(injected.body);
      } catch (err) {
        log.error({ err, path: env.path }, "shard replay inject failed");
        reply.code(502).send({ error: "shard replay failed" });
      }
    });
  });

  if (config.bot.totalShards > 1 && Object.keys(config.shard.urls).length > 0) {
    log.info(
      {
        shardId: config.bot.shardId,
        totalShards: config.bot.totalShards,
        knownShardUrls: Object.keys(config.shard.urls).length,
        hmac: secret ? "configured" : "MISSING",
      },
      "cross-shard forwarding enabled (PR-3.3)",
    );
  }
}

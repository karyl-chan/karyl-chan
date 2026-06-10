import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { verifyInboundSignatureFromHeadersWithKeys } from "./hmac.js";

/**
 * Shared scaffolding for an HMAC-signed inbound route scope (the bot's
 * internal channels: voice-service → bot, sibling shard → bot).
 *
 * Registers a raw-string JSON body parser on `scoped` (so the signature is
 * verified over the EXACT received bytes, not a re-serialised object) and
 * returns a `verify(request, reply)` guard that:
 *   - 503s when no key is configured (misconfig guard),
 *   - reads the verification keys FRESH per request via `getKeys` (so a
 *     rotated secret takes effect without a restart),
 *   - 401s on a bad/expired signature, checking `[current, previous]`
 *     uniformly via the rotation-aware verifier.
 *
 * Both `voice-internal-routes` and `shard-forward-routes` use this so the
 * one security-critical verify path lives in a single place and can't drift
 * between the two channels.
 */
export function makeSignedVerify(
  scoped: FastifyInstance,
  getKeys: () => readonly string[],
): (request: FastifyRequest, reply: FastifyReply) => boolean {
  scoped.addContentTypeParser(
    "application/json",
    { parseAs: "string" },
    (_req, body, done) => done(null, body),
  );

  return (request: FastifyRequest, reply: FastifyReply): boolean => {
    const keys = getKeys();
    if (keys.length === 0) {
      reply.code(503).send({ error: "HMAC secret not configured" });
      return false;
    }
    const rawBody = typeof request.body === "string" ? request.body : "";
    const check = verifyInboundSignatureFromHeadersWithKeys(
      keys,
      request.headers,
      rawBody,
      Math.floor(Date.now() / 1000),
      request.method,
      request.url.split("?")[0] ?? request.url,
      // 對內簽章路由（voice→bot / shard→shard）：發送端皆已升級新格式，
      // request 驗證一律要求 nonce 並做重放追蹤（BH-2.4）。
      { requireNonce: true },
    );
    if (!check.ok) {
      reply.code(401).send({ error: check.reason });
      return false;
    }
    return true;
  };
}

/**
 * GET /.well-known/jwks.json (#126) — the public keys self-hosted services
 * verify service tokens with (see service-token.ts): the active signing
 * key and keys retired within the last 24 h, `kid` = key row id.
 *
 * Public by nature, so it lives outside /api (the auth hook never sees
 * it). Registered explicitly — the SPA not-found handler would otherwise
 * answer it with index.html. Rate-limited per client like the /api/auth/*
 * endpoints, and served from the JWKS cache so a flood never reaches the DB.
 */

import type { FastifyInstance } from "fastify";
import { RateLimiter } from "../../utils/rate-limiter.js";
import { recordAuthThrottled } from "../bot-events/auth-throttle-log.js";
import { refuseIfThrottled, type ClientThrottle } from "./client-throttle.js";
import { getJwks, type Jwks } from "./jwt.service.js";

export const JWKS_PATH = "/.well-known/jwks.json";

// A service fetches the set on start and on an unknown `kid`; 60/min per
// client leaves room for that and a few restarts.
const jwksRateLimiter = new RateLimiter({ windowMs: 60_000, max: 60 });

export function registerJwksRoute(
  server: FastifyInstance,
  options: { limiter?: ClientThrottle; jwks?: () => Promise<Jwks> } = {},
): void {
  const limiter = options.limiter ?? jwksRateLimiter;
  const load = options.jwks ?? (() => getJwks());
  server.get(JWKS_PATH, async (request, reply) => {
    if (
      refuseIfThrottled(limiter, request, reply, {
        path: JWKS_PATH,
        message: "Too many requests, slow down",
        onThrottled: recordAuthThrottled,
      })
    ) {
      return reply;
    }
    return reply
      .header("Content-Type", "application/jwk-set+json; charset=utf-8")
      // Short, so a service that caches by header picks up a rotation
      // within a minute even before it sees the new `kid`.
      .header("Cache-Control", "public, max-age=60")
      .send(JSON.stringify(await load()));
  });
}

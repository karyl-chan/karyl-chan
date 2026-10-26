/**
 * Per-client throttling for the unauthenticated endpoints under
 * /api/auth/ — there is no user to key on, so the client is its address.
 *
 * `clientKey` reflects the trust-proxy configuration: when
 * config.web.trustedProxy is on and the peer is a trusted proxy, Fastify
 * unwraps X-Forwarded-For; otherwise it is the socket peer (see
 * createWebServer). `refuseIfThrottled` answers 429 and reports the hit
 * through `onThrottled` (the caller's log — web-core does not log to a
 * business module itself).
 */

import type { FastifyReply, FastifyRequest } from "fastify";

export const AUTH_EXCHANGE_PATH = "/api/auth/exchange";
export const AUTH_REFRESH_PATH = "/api/auth/refresh";
/** Served by the behavior module (login-trigger-hint-route.ts). */
export const AUTH_LOGIN_TRIGGER_PATH = "/api/auth/login-trigger";

export function clientKey(request: FastifyRequest): string {
  return request.ip || "unknown";
}

export interface ClientThrottle {
  isRateLimited(key: string): boolean;
}

/**
 * True when `request`'s client is over `limiter`'s budget: the 429 has
 * been sent and the handler should stop.
 */
export function refuseIfThrottled(
  limiter: ClientThrottle,
  request: FastifyRequest,
  reply: FastifyReply,
  options: {
    path: string;
    message: string;
    onThrottled?: (path: string, ip: string) => void;
  },
): boolean {
  const ip = clientKey(request);
  if (!limiter.isRateLimited(ip)) return false;
  options.onThrottled?.(options.path, ip);
  reply.code(429).send({ error: options.message });
  return true;
}

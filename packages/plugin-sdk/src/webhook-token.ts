import { timingSafeEqual } from "node:crypto";

/**
 * Verify the `X-Plugin-Webhook-Token` header sent by the bot
 * when `webhookAuthMode='token'` is configured for a behavior.
 *
 * Uses `timingSafeEqual` to prevent timing-based secret inference.
 * Length-mismatch is handled by padding to the longer length before
 * comparison — this avoids leaking length information through early exit.
 *
 * @param headerValue  The raw header value from the incoming request,
 *                     e.g. `request.headers['x-plugin-webhook-token']`.
 *                     May be `undefined` (header absent) or a string.
 * @param secret       The shared secret configured in admin/behaviors UI.
 * @returns            `true` if the header matches the secret; `false` otherwise.
 *
 * @example
 * import { verifyWebhookToken } from '@karyl-chan/plugin-sdk';
 *
 * // In a Fastify route handler:
 * const ok = verifyWebhookToken(
 *   request.headers['x-plugin-webhook-token'],
 *   process.env.WEBHOOK_SECRET!,
 * );
 * if (!ok) {
 *   return reply.code(401).send({ error: 'unauthorized' });
 * }
 */
export function verifyWebhookToken(
  headerValue: string | undefined,
  secret: string,
): boolean {
  if (typeof headerValue !== "string" || headerValue.length === 0) {
    return false;
  }
  const presented = Buffer.from(headerValue, "utf8");
  const expected = Buffer.from(secret, "utf8");
  // Pad both buffers to the same length to prevent length-timing leaks.
  // The constant-time comparison is only valid when lengths are equal;
  // if they differ, we compare against a same-length zero-padded copy
  // of the shorter one — guaranteed to mismatch, but without leaking
  // which side was shorter.
  const len = Math.max(presented.length, expected.length);
  const a = Buffer.alloc(len, 0);
  const b = Buffer.alloc(len, 0);
  presented.copy(a);
  expected.copy(b);
  return timingSafeEqual(a, b);
}

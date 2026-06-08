import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Verify the `X-Plugin-Webhook-Token` header sent by the bot
 * when `webhookAuthMode='token'` is configured for a behavior.
 *
 * Compares SHA-256 digests of the two values with `timingSafeEqual`:
 * the digests are always 32 bytes (so the compare is constant-time with
 * no length leak), and an exact match is required — two values that
 * differ at all, including by length or trailing NUL bytes, hash
 * differently and are rejected.
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
  // Hash both sides to fixed-length (32-byte) digests before comparing.
  // This keeps the compare constant-time and length-agnostic while still
  // requiring an EXACT match — the previous zero-padding approach treated
  // `secret + "\0"` (and any trailing-NUL variant) as equal.
  const presented = createHash("sha256").update(headerValue, "utf8").digest();
  const expected = createHash("sha256").update(secret, "utf8").digest();
  return timingSafeEqual(presented, expected);
}

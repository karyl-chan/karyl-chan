import { createHmac, timingSafeEqual } from "node:crypto";

// HMAC scheme used for every bot ↔ plugin signed request.
//
// Signed payload  : `<METHOD>:<path>:<ts>:<body>`
// Header layout   : `x-karyl-signature: <hex>`
//                   `x-karyl-timestamp: <unix-seconds>`
//
// Binding METHOD + path into the signed payload prevents a captured
// signature from being replayed against a different endpoint or verb.
//
// Both sides MUST hash the exact same bytes — any drift in this file
// (separator, header name, body encoding) breaks verification.

export const SIGNATURE_HEADER = "x-karyl-signature";
export const TIMESTAMP_HEADER = "x-karyl-timestamp";
export const REPLAY_WINDOW_SECONDS = 300;

/** Compute the hex SHA-256 HMAC over `<METHOD>:<path>:<ts>:<body>`. */
export function sign(
  secret: string,
  method: string,
  path: string,
  ts: string,
  body: string,
): string {
  return createHmac("sha256", secret)
    .update(`${method.toUpperCase()}:${path}:${ts}:${body}`)
    .digest("hex");
}

/**
 * Constant-time signature check. `presented` is the raw hex value from
 * the `x-karyl-signature` header.
 */
export function verify(opts: {
  secret: string;
  method: string;
  path: string;
  ts: string;
  body: string;
  presented: string;
}): boolean {
  const expected = sign(opts.secret, opts.method, opts.path, opts.ts, opts.body);
  const a = Buffer.from(opts.presented, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** True if `ts` (unix seconds, string) is within the replay window of now. */
export function isFreshTimestamp(ts: string, nowSec: number): boolean {
  const n = Number.parseInt(ts, 10);
  if (!Number.isFinite(n)) return false;
  return Math.abs(nowSec - n) <= REPLAY_WINDOW_SECONDS;
}

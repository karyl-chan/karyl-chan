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

/**
 * One-call verification helper for plugins that mount their own
 * bot-dispatched routes (custom webhook receivers, debug endpoints,
 * …). For the built-in `/commands` / `/components` / `/modals` /
 * `/events` / `/_kc/lifecycle` routes, the SDK already calls this
 * internally — plugin authors should NOT re-verify those.
 *
 * Returns `{ ok: true }` when the signature is valid and the
 * timestamp is fresh; otherwise `{ ok: false, reason }` with a short
 * machine-readable string so the caller can map to an HTTP status
 * (`401` is the common choice).
 *
 * Expected to be called with the raw request body bytes — Fastify
 * authors typically register a content-type parser that hands the
 * raw string through (see `server.ts`'s `addContentTypeParser`
 * registration). JSON-parsed-then-re-stringified bodies do NOT
 * verify; the canonical form is the bytes that crossed the wire.
 */
export function verifyDispatchHmac(args: {
  secret: string;
  method: string;
  path: string;
  body: string;
  headers: Record<string, string | string[] | undefined>;
  nowSec?: number;
}):
  | { ok: true }
  | { ok: false; reason: "missing_timestamp" | "missing_signature" | "stale_timestamp" | "signature_mismatch" } {
  const ts = args.headers[TIMESTAMP_HEADER];
  const sig = args.headers[SIGNATURE_HEADER];
  if (typeof ts !== "string") return { ok: false, reason: "missing_timestamp" };
  if (typeof sig !== "string") return { ok: false, reason: "missing_signature" };
  const nowSec = args.nowSec ?? Math.floor(Date.now() / 1000);
  if (!isFreshTimestamp(ts, nowSec)) {
    return { ok: false, reason: "stale_timestamp" };
  }
  if (
    !verify({
      secret: args.secret,
      method: args.method,
      path: args.path,
      ts,
      body: args.body,
      presented: sig,
    })
  ) {
    return { ok: false, reason: "signature_mismatch" };
  }
  return { ok: true };
}

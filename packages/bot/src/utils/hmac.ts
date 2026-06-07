import { createHmac, timingSafeEqual } from "crypto";

/**
 * HMAC signature helpers for bot ↔ plugin / webhook communication.
 *
 * Signed payload  : `<METHOD>:<url-path>:<timestamp>:<body>`
 * Header layout   : `x-karyl-signature: <hex>`
 *                   `x-karyl-timestamp: <unix-seconds>`
 *
 * Binding METHOD + URL path into the signed payload prevents a
 * signature captured on one endpoint from being replayed against a
 * different endpoint or HTTP verb within the replay window.
 */

export const SIGNATURE_HEADER = "x-karyl-signature";
export const TIMESTAMP_HEADER = "x-karyl-timestamp";

// Replay window is deliberately not configurable here — it is a
// security constant, not a tuning knob. Callers that need visibility
// can re-export the constant.
export const REPLAY_WINDOW_SECONDS = 300;

// ─── Low-level sign ───────────────────────────────────────────────────

/**
 * Compute HMAC over `<METHOD>:<url-path>:<timestamp>:<body>`.
 * `method` should be upper-cased (e.g. "POST").
 * `path` should be the URL pathname only (e.g. "/dm/greet/dispatch").
 * Returns the raw hex digest.
 */
export function signBody(
  secret: string,
  method: string,
  path: string,
  timestamp: string,
  body: string,
): string {
  return createHmac("sha256", secret)
    .update(`${method.toUpperCase()}:${path}:${timestamp}:${body}`)
    .digest("hex");
}

// ─── Timing-safe equality ─────────────────────────────────────────────

function constantTimeEq(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

// ─── Outbound signing ─────────────────────────────────────────────────

/**
 * Build the HMAC headers for an outbound POST request.
 *
 * @param secret   Shared HMAC secret
 * @param method   HTTP method, e.g. "POST"
 * @param urlPath  URL pathname, e.g. "/dm/greet/dispatch"
 * @param body     Request body string (already serialised)
 * @param ts       Optional unix-epoch-seconds string; defaults to now
 */
export function buildOutboundSignatureHeaders(
  secret: string,
  method: string,
  urlPath: string,
  body: string,
  ts?: string,
): Record<string, string> {
  const timestamp = ts ?? Math.floor(Date.now() / 1000).toString();
  const sig = signBody(secret, method, urlPath, timestamp, body);
  return {
    [TIMESTAMP_HEADER]: timestamp,
    [SIGNATURE_HEADER]: sig,
  };
}

// ─── Inbound verification ─────────────────────────────────────────────

export type SignatureCheck = { ok: true } | { ok: false; reason: string };

/**
 * Verify HMAC headers on an inbound response (plugin → bot direction).
 *
 * `method` and `urlPath` are the method/path of the *original request*
 * that produced this response; they are bound into the signed payload.
 *
 * @param secret    Shared HMAC secret
 * @param headers   Response headers
 * @param rawBody   Raw response body string
 * @param nowSec    Current unix epoch seconds (for replay-window check)
 * @param method    HTTP method used for the original request (e.g. "POST")
 * @param urlPath   URL pathname of the original request
 */
export function verifyInboundSignature(
  secret: string,
  headers: Headers,
  rawBody: string,
  nowSec: number,
  method: string,
  urlPath: string,
): SignatureCheck {
  const sigHeader = headers.get(SIGNATURE_HEADER);
  const tsHeader = headers.get(TIMESTAMP_HEADER);

  if (!tsHeader) {
    return { ok: false, reason: "missing X-Karyl-Timestamp on response" };
  }
  if (!sigHeader) {
    return { ok: false, reason: "missing X-Karyl-Signature on response" };
  }

  const tsNum = Number.parseInt(tsHeader, 10);
  if (!Number.isFinite(tsNum)) {
    return { ok: false, reason: "malformed X-Karyl-Timestamp on response" };
  }
  if (Math.abs(nowSec - tsNum) > REPLAY_WINDOW_SECONDS) {
    return { ok: false, reason: "response timestamp outside replay window" };
  }

  const expected = signBody(secret, method, urlPath, tsHeader, rawBody);
  if (!constantTimeEq(sigHeader, expected)) {
    return { ok: false, reason: "response signature mismatch" };
  }
  return { ok: true };
}

/**
 * Verify HMAC headers on an inbound REQUEST whose headers are a plain record
 * (Fastify `request.headers`) rather than a fetch `Headers`. Same scheme as
 * `verifyInboundSignature` — used by the bot's internal voice routes
 * (voice service → bot) which receive a signed POST with the shared secret.
 */
export function verifyInboundSignatureFromHeaders(
  secret: string,
  headers: Record<string, string | string[] | undefined>,
  rawBody: string,
  nowSec: number,
  method: string,
  urlPath: string,
): SignatureCheck {
  const one = (v: string | string[] | undefined): string | undefined =>
    Array.isArray(v) ? v[0] : v;
  const tsHeader = one(headers[TIMESTAMP_HEADER]);
  const sigHeader = one(headers[SIGNATURE_HEADER]);
  if (!tsHeader) return { ok: false, reason: "missing timestamp" };
  if (!sigHeader) return { ok: false, reason: "missing signature" };
  const tsNum = Number.parseInt(tsHeader, 10);
  if (!Number.isFinite(tsNum)) {
    return { ok: false, reason: "malformed timestamp" };
  }
  if (Math.abs(nowSec - tsNum) > REPLAY_WINDOW_SECONDS) {
    return { ok: false, reason: "timestamp outside replay window" };
  }
  const expected = signBody(secret, method, urlPath, tsHeader, rawBody);
  if (!constantTimeEq(sigHeader, expected)) {
    return { ok: false, reason: "signature mismatch" };
  }
  return { ok: true };
}

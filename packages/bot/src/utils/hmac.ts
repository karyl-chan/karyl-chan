import { createHmac, randomBytes, timingSafeEqual } from "crypto";

/**
 * HMAC signature helpers for bot ↔ plugin / webhook communication.
 *
 * Signed payload  : `<METHOD>:<url-path>:<timestamp>:<nonce>:<body>`
 * Header layout   : `x-karyl-signature: <hex>`
 *                   `x-karyl-timestamp: <unix-seconds>`
 *                   `x-karyl-nonce: <hex>`
 *
 * Binding METHOD + URL path into the signed payload prevents a
 * signature captured on one endpoint from being replayed against a
 * different endpoint or HTTP verb within the replay window. The nonce
 * (BH-2.4) closes the remaining window: receivers that require it also
 * remember seen nonces for the freshness window and reject duplicates.
 *
 * RESPONSE verification stays nonce-OPTIONAL for compatibility — a
 * response rides the request's own connection, so response replay isn't
 * a stored-request attack the way request replay is. When a response
 * does carry the nonce header, the new format is enforced.
 */

export const SIGNATURE_HEADER = "x-karyl-signature";
export const TIMESTAMP_HEADER = "x-karyl-timestamp";
export const NONCE_HEADER = "x-karyl-nonce";

/** Fresh random nonce for one outbound request. */
export function generateNonce(): string {
  return randomBytes(16).toString("hex");
}

// Replay window is deliberately not configurable here — it is a
// security constant, not a tuning knob. Callers that need visibility
// can re-export the constant.
export const REPLAY_WINDOW_SECONDS = 300;

// ─── Low-level sign ───────────────────────────────────────────────────

/**
 * Compute HMAC over `<METHOD>:<url-path>:<timestamp>:<nonce>:<body>`
 * (or the legacy nonce-less form when `nonce` is null — response
 * verification keeps accepting it).
 * `method` should be upper-cased (e.g. "POST").
 * `path` should be the URL pathname only (e.g. "/dm/greet/dispatch").
 * Returns the raw hex digest.
 */
export function signBody(
  secret: string,
  method: string,
  path: string,
  timestamp: string,
  nonce: string | null,
  body: string,
): string {
  const payload =
    nonce === null
      ? `${method.toUpperCase()}:${path}:${timestamp}:${body}`
      : `${method.toUpperCase()}:${path}:${timestamp}:${nonce}:${body}`;
  return createHmac("sha256", secret).update(payload).digest("hex");
}

// ── Nonce replay tracking（受 requireNonce 的驗證點使用）─────────────────

const seenNonces = new Map<string, number>();
let lastPrune = 0;

function markNonceSeen(nonce: string, nowSec: number): boolean {
  if (nowSec - lastPrune >= REPLAY_WINDOW_SECONDS) {
    lastPrune = nowSec;
    for (const [n, expiry] of seenNonces) {
      if (expiry <= nowSec) seenNonces.delete(n);
    }
  }
  const expiry = seenNonces.get(nonce);
  if (expiry !== undefined && expiry > nowSec) return false;
  seenNonces.set(nonce, nowSec + REPLAY_WINDOW_SECONDS);
  return true;
}

/** Test hook: clear the nonce replay store. */
export function __resetNonceStoreForTests(): void {
  seenNonces.clear();
  lastPrune = 0;
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
  nonce?: string,
): Record<string, string> {
  const timestamp = ts ?? Math.floor(Date.now() / 1000).toString();
  const n = nonce ?? generateNonce();
  const sig = signBody(secret, method, urlPath, timestamp, n, body);
  return {
    [TIMESTAMP_HEADER]: timestamp,
    [SIGNATURE_HEADER]: sig,
    [NONCE_HEADER]: n,
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
  opts?: { requireNonce?: boolean },
): SignatureCheck {
  const sigHeader = headers.get(SIGNATURE_HEADER);
  const tsHeader = headers.get(TIMESTAMP_HEADER);
  const nonceHeader = headers.get(NONCE_HEADER);

  if (!tsHeader) {
    return { ok: false, reason: "missing X-Karyl-Timestamp on response" };
  }
  if (!sigHeader) {
    return { ok: false, reason: "missing X-Karyl-Signature on response" };
  }
  if (opts?.requireNonce && !nonceHeader) {
    return { ok: false, reason: "missing X-Karyl-Nonce" };
  }

  const tsNum = Number.parseInt(tsHeader, 10);
  if (!Number.isFinite(tsNum)) {
    return { ok: false, reason: "malformed X-Karyl-Timestamp on response" };
  }
  if (Math.abs(nowSec - tsNum) > REPLAY_WINDOW_SECONDS) {
    return { ok: false, reason: "response timestamp outside replay window" };
  }

  // nonce 帶了就用新格式驗；沒帶（且不強制）走 legacy 格式 —— 僅限
  // response 驗證的相容窗口，request 驗證點一律 requireNonce。
  const expected = signBody(
    secret,
    method,
    urlPath,
    tsHeader,
    nonceHeader ?? null,
    rawBody,
  );
  if (!constantTimeEq(sigHeader, expected)) {
    return { ok: false, reason: "response signature mismatch" };
  }
  if (opts?.requireNonce && nonceHeader) {
    if (!markNonceSeen(nonceHeader, nowSec)) {
      return { ok: false, reason: "replayed nonce" };
    }
  }
  return { ok: true };
}

/**
 * Rotation-aware inbound verification (PR-5.1).
 *
 * Tries each candidate secret in order and accepts the response if ANY of
 * them validates. This lets a *shared* static secret (e.g. the bot↔voice
 * VOICE_HMAC_SECRET) be rotated without a synchronized restart: during the
 * rotation window the verifier holds `[current, previous]`, so it accepts
 * signatures from a counterpart still on either key.
 *
 * The single-key path is preserved exactly: pass a one-element array and
 * the behaviour is byte-for-byte `verifyInboundSignature`. An empty array
 * fails closed (no configured secret ⇒ reject).
 *
 * Note the timestamp/replay checks are independent of the key, so the
 * common rejection reasons (missing/expired timestamp) short-circuit
 * before any key is tried — only a genuine signature mismatch walks the
 * full candidate list, and the reason returned is the last attempt's.
 */
export function verifyInboundSignatureWithKeys(
  secrets: readonly string[],
  headers: Headers,
  rawBody: string,
  nowSec: number,
  method: string,
  urlPath: string,
  opts?: { requireNonce?: boolean },
): SignatureCheck {
  if (secrets.length === 0) {
    return { ok: false, reason: "no verification key configured" };
  }
  let last: SignatureCheck = { ok: false, reason: "no verification key configured" };
  for (const secret of secrets) {
    last = verifyInboundSignature(
      secret,
      headers,
      rawBody,
      nowSec,
      method,
      urlPath,
      opts,
    );
    if (last.ok) return last;
    // A timestamp-level failure (missing/malformed/outside-window) is the
    // same for every key, so stop early rather than re-checking — only a
    // signature mismatch is worth trying the next key against.
    if (last.reason !== "response signature mismatch") return last;
  }
  return last;
}

/**
 * Verify HMAC headers on an inbound REQUEST whose headers are a plain record
 * (Fastify `request.headers`) against one or more keys: accepts if ANY of
 * `secrets` validates (PR-5.1). Used by the bot's signed internal routes
 * (voice service → bot, sibling shard → bot) so a shared secret can be
 * rotated (current + previous) without restarting both sides at once. A
 * single-element array == single-key behaviour.
 */
export function verifyInboundSignatureFromHeadersWithKeys(
  secrets: readonly string[],
  headers: Record<string, string | string[] | undefined>,
  rawBody: string,
  nowSec: number,
  method: string,
  urlPath: string,
  opts?: { requireNonce?: boolean },
): SignatureCheck {
  return verifyInboundSignatureWithKeys(
    secrets,
    recordHeadersToFetch(headers),
    rawBody,
    nowSec,
    method,
    urlPath,
    opts,
  );
}

/**
 * Adapt Fastify record headers to a fetch `Headers` carrying just the two
 * signature headers, so the replay-window + constant-time compare live in
 * exactly one place (`verifyInboundSignature`) and are never cloned.
 */
function recordHeadersToFetch(
  headers: Record<string, string | string[] | undefined>,
): Headers {
  const one = (v: string | string[] | undefined): string | undefined =>
    Array.isArray(v) ? v[0] : v;
  const h = new Headers();
  const ts = one(headers[TIMESTAMP_HEADER]);
  const sig = one(headers[SIGNATURE_HEADER]);
  const nonce = one(headers[NONCE_HEADER]);
  if (ts) h.set(TIMESTAMP_HEADER, ts);
  if (sig) h.set(SIGNATURE_HEADER, sig);
  if (nonce) h.set(NONCE_HEADER, nonce);
  return h;
}

// ─── Signed POST ──────────────────────────────────────────────────────

/**
 * Serialise `body` to JSON, attach the HMAC headers, and POST it. Returns
 * the raw `Response` so each caller applies its own status handling (e.g.
 * 429 → capacity). The single place the bot→voice internal channel
 * assembles a signed request, so the on-the-wire bytes stay identical
 * across callers.
 */
export async function signedJsonPost(
  secret: string,
  baseUrl: string,
  path: string,
  body: unknown,
): Promise<Response> {
  const raw = JSON.stringify(body ?? {});
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...buildOutboundSignatureHeaders(secret, "POST", path, raw),
    },
    body: raw,
  });
}

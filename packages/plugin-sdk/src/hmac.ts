import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// HMAC scheme used for every bot ↔ plugin signed request.
//
// Signed payload  : `<METHOD>:<path>:<ts>:<nonce>:<body>`
// Header layout   : `x-karyl-signature: <hex>`
//                   `x-karyl-timestamp: <unix-seconds>`
//                   `x-karyl-nonce: <hex>`
//
// Binding METHOD + path into the signed payload prevents a captured
// signature from being replayed against a different endpoint or verb.
// The nonce (BH-2.4) closes the remaining replay window: receivers
// remember seen nonces for the freshness window and reject duplicates,
// so a captured request can't be replayed at the SAME endpoint either.
//
// Both sides MUST hash the exact same bytes — any drift in this file
// (separator, header name, body encoding) breaks verification.

export const SIGNATURE_HEADER = "x-karyl-signature";
export const TIMESTAMP_HEADER = "x-karyl-timestamp";
export const NONCE_HEADER = "x-karyl-nonce";
export const REPLAY_WINDOW_SECONDS = 300;

/** Fresh random nonce for one outbound request. */
export function generateNonce(): string {
  return randomBytes(16).toString("hex");
}

/** Compute the hex SHA-256 HMAC over `<METHOD>:<path>:<ts>:<nonce>:<body>`. */
export function sign(
  secret: string,
  method: string,
  path: string,
  ts: string,
  nonce: string,
  body: string,
): string {
  return createHmac("sha256", secret)
    .update(`${method.toUpperCase()}:${path}:${ts}:${nonce}:${body}`)
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
  nonce: string;
  body: string;
  presented: string;
}): boolean {
  const expected = sign(
    opts.secret,
    opts.method,
    opts.path,
    opts.ts,
    opts.nonce,
    opts.body,
  );
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

// ── Nonce replay tracking ───────────────────────────────────────────────
//
// In-process TTL set: a nonce is remembered for the freshness window;
// a second request presenting the same nonce inside that window is a
// replay. Per-process state — good enough for a single plugin instance;
// multi-replica deployments behind a balancer would need a shared store
// to be airtight (each replica only rejects replays it saw itself).

const seenNonces = new Map<string, number>();
let lastPrune = 0;

function pruneNonces(nowSec: number): void {
  if (nowSec - lastPrune < REPLAY_WINDOW_SECONDS) return;
  lastPrune = nowSec;
  for (const [nonce, expiry] of seenNonces) {
    if (expiry <= nowSec) seenNonces.delete(nonce);
  }
}

/**
 * Record `nonce` as seen; returns false when it was already seen inside
 * the replay window (= a replay).
 */
export function markNonceSeen(nonce: string, nowSec: number): boolean {
  pruneNonces(nowSec);
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

/**
 * One-call verification helper for plugins that mount their own
 * bot-dispatched routes (custom webhook receivers, debug endpoints,
 * …). For the built-in `/commands` / `/components` / `/modals` /
 * `/events` / `/_kc/lifecycle` routes, the SDK already calls this
 * internally — plugin authors should NOT re-verify those.
 *
 * Returns `{ ok: true }` when the signature is valid, the timestamp is
 * fresh, and the nonce hasn't been seen inside the replay window;
 * otherwise `{ ok: false, reason }` with a short machine-readable
 * string so the caller can map to an HTTP status (`401` is the common
 * choice).
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
  | {
      ok: false;
      reason:
        | "missing_timestamp"
        | "missing_signature"
        | "missing_nonce"
        | "stale_timestamp"
        | "replayed_nonce"
        | "signature_mismatch";
    } {
  const ts = args.headers[TIMESTAMP_HEADER];
  const sig = args.headers[SIGNATURE_HEADER];
  const nonce = args.headers[NONCE_HEADER];
  if (typeof ts !== "string") return { ok: false, reason: "missing_timestamp" };
  if (typeof sig !== "string") return { ok: false, reason: "missing_signature" };
  if (typeof nonce !== "string" || nonce.length === 0) {
    return { ok: false, reason: "missing_nonce" };
  }
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
      nonce,
      body: args.body,
      presented: sig,
    })
  ) {
    return { ok: false, reason: "signature_mismatch" };
  }
  // Signature first, replay check second: only a VALID request may
  // consume a nonce slot (otherwise garbage requests could poison
  // future legitimate nonces).
  if (!markNonceSeen(nonce, nowSec)) {
    return { ok: false, reason: "replayed_nonce" };
  }
  return { ok: true };
}

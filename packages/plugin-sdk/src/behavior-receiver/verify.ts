import { nowSeconds, safeEqual, signatureHex, type RawBody } from "./crypto.js";
import { PROTOCOL } from "./protocol.js";

/** The authentication a behavior's webhook action is set to. */
export type BehaviorAuthMode = "none" | "token" | "hmac";

/**
 * Request headers, as `node:http` gives them (`req.headers`). Names are
 * matched case-insensitively; a repeated header (an array) counts as
 * missing.
 */
export type RequestHeaders = Readonly<
  Record<string, string | readonly string[] | undefined>
>;

/**
 * Where seen nonces are remembered, for replay protection in hmac mode.
 * `createNonceStore()` is an in-memory one; pass your own to share it
 * between processes.
 *
 * `set` is called only after a request's signature has been verified, with
 * the unix time (seconds) after which the nonce may be forgotten. It may
 * return (or resolve to) `false` when the nonce was already there, as an
 * atomic insert does (Redis `SET NX`): the request is then a replay. Use
 * that with a shared store, where two copies of one request can pass
 * `has` at the same time.
 */
export interface NonceStore {
  has(nonce: string): boolean | PromiseLike<boolean>;
  set(nonce: string, expiresAt: number): unknown;
}

/** One secret, or several while the receiver itself moves between secrets. */
export type ReceiverSecrets =
  | { secret: string }
  | { secrets: readonly string[] };

interface VerifyBase {
  /** The path of the webhook URL as saved on the bot, without the query string. */
  path: string;
  headers: RequestHeaders;
  /** The raw body, exactly as received. */
  body: RawBody;
  /** Unix time in seconds. Defaults to the clock. */
  now?: number;
}

export type VerifyRequestOptions =
  | (VerifyBase & { mode: "none" })
  | (VerifyBase &
      ReceiverSecrets & {
        // one member for both, so a mode read from config type-checks
        mode: "token" | "hmac";
        /** Read in hmac mode only: a token-mode nonce is not signed. */
        nonceStore: NonceStore;
      });

export type VerifyFailureReason =
  | "missing signature headers"
  | "stale timestamp"
  | "signature mismatch"
  | "replayed nonce"
  | "token mismatch";

export type VerifyResult =
  | {
      ok: true;
      /** An admin test-fire: answer it with something harmless. */
      test: boolean;
      /** The request's nonce, to sign the response over (null when none was sent). */
      nonce: string | null;
      /** The secret that verified, to sign the response with (null in mode "none"). */
      secret: string | null;
    }
  | { ok: false; reason: VerifyFailureReason };

function headerReader(
  headers: RequestHeaders,
): (name: string) => string | undefined {
  const lower = new Map<string, string>();
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value === "string") lower.set(name.toLowerCase(), value);
  }
  return (name) => lower.get(name);
}

/**
 * The usable secrets. An empty one is dropped: anyone can send an empty
 * token, or sign with an empty key.
 */
export function secretsOf(options: ReceiverSecrets): readonly string[] {
  const all = "secrets" in options ? options.secrets : [options.secret];
  return all.filter((s) => typeof s === "string" && s.length > 0);
}

const isThenable = (v: unknown): v is PromiseLike<unknown> =>
  typeof (v as PromiseLike<unknown> | null)?.then === "function";

/**
 * Checks one request from the bot: the token or signature for its mode,
 * the test-fire scheme (`X-Karyl-Test: 1`), the `-Previous` headers of a
 * rotation, the timestamp window and, in hmac mode, a replayed nonce.
 */
export async function verifyRequest(
  options: VerifyRequestOptions,
): Promise<VerifyResult> {
  const header = headerReader(options.headers);
  const test = header(PROTOCOL.testHeader) === "1";
  const nonce = header(PROTOCOL.nonceHeader) ?? null;

  if (options.mode === "none") return { ok: true, test, nonce, secret: null };

  const secrets = secretsOf(options);

  if (options.mode === "token") {
    // A test-fire's token travels in its own header.
    const presented = test
      ? [
          header(PROTOCOL.testTokenHeader),
          header(PROTOCOL.testPreviousTokenHeader),
        ]
      : [header(PROTOCOL.tokenHeader), header(PROTOCOL.previousTokenHeader)];
    const secret = secrets.find((s) => presented.some((p) => safeEqual(p, s)));
    return secret === undefined
      ? { ok: false, reason: "token mismatch" }
      : { ok: true, test, nonce, secret };
  }

  const ts = header(PROTOCOL.timestampHeader);
  if (ts === undefined || nonce === null || !/^\d+$/.test(ts)) {
    return { ok: false, reason: "missing signature headers" };
  }
  const now = options.now ?? nowSeconds();
  if (Math.abs(now - Number(ts)) > PROTOCOL.replayWindowSeconds) {
    return { ok: false, reason: "stale timestamp" };
  }
  // During a rotation the bot signs the standard header with its new
  // secret and the -Previous header with the old one.
  const presented = [
    header(PROTOCOL.signatureHeader),
    header(PROTOCOL.previousSignatureHeader),
  ];
  const secret = secrets.find((s) => {
    const expected = signatureHex({
      secret: s,
      test,
      path: options.path,
      ts,
      nonce,
      body: options.body,
    });
    return presented.some((p) => safeEqual(p, expected));
  });
  if (secret === undefined) return { ok: false, reason: "signature mismatch" };

  // The replay check comes after the signature, so only the bot can fill
  // the store. A nonce is kept as long as its timestamp stays fresh.
  // A synchronous store is checked and written with no await between.
  const store = options.nonceStore;
  const seen = store.has(nonce);
  if (isThenable(seen) ? await seen : seen)
    return { ok: false, reason: "replayed nonce" };
  const stored = store.set(nonce, Number(ts) + PROTOCOL.replayWindowSeconds);
  if ((isThenable(stored) ? await stored : stored) === false) {
    return { ok: false, reason: "replayed nonce" };
  }
  return { ok: true, test, nonce, secret };
}

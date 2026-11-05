import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import { PROTOCOL } from "./protocol.js";

/** Unix time in whole seconds, the protocol's clock. */
export const nowSeconds = (): number => Math.floor(Date.now() / 1000);

/** A request or response body: the raw bytes, or their UTF-8 text. */
export type RawBody = string | Uint8Array;

/**
 * Hex HMAC-SHA256 over the signed string
 * `[test:]<METHOD>:<path>:<ts>:<nonce>:<body>`. The body is hashed as the
 * bytes given, never re-encoded.
 */
export function signatureHex(input: {
  secret: string;
  test: boolean;
  path: string;
  ts: string;
  nonce: string;
  body: RawBody;
}): string {
  const prefix = input.test ? PROTOCOL.testPrefix : "";
  return createHmac("sha256", input.secret)
    .update(`${prefix}POST:${input.path}:${input.ts}:${input.nonce}:`)
    .update(input.body)
    .digest("hex");
}

const digest = (s: string) => createHash("sha256").update(s).digest();

/**
 * Constant-time string equality. Both sides are hashed first, so the
 * comparison never throws on a byte-length difference and the time it
 * takes says nothing about the secret's length.
 */
export function safeEqual(
  presented: string | undefined,
  expected: string,
): boolean {
  if (typeof presented !== "string") return false;
  return timingSafeEqual(digest(presented), digest(expected));
}

import { nowSeconds, signatureHex, type RawBody } from "./crypto.js";
import { PROTOCOL } from "./protocol.js";

export interface SignResponseOptions {
  /** The secret the request verified with (`VerifyResult.secret`). */
  secret: string;
  /** The path of the webhook URL as saved on the bot, as for the request. */
  path: string;
  /** The REQUEST's nonce (`VerifyResult.nonce`): the signature is bound to it. */
  nonce: string;
  /** A test-fire's response is signed under the test prefix (`VerifyResult.test`). */
  test: boolean;
  /** The response body as it will be sent; the empty string for none. */
  body: RawBody;
  /** Unix time in seconds. Defaults to the clock. */
  now?: number;
}

/**
 * The headers that sign a response: its own timestamp, and a signature
 * over the request's method, path and nonce and the response body.
 * Required in hmac mode; in token mode optional, but verified when sent.
 */
export function signResponse(
  options: SignResponseOptions,
): Record<string, string> {
  const ts = String(options.now ?? nowSeconds());
  return {
    [PROTOCOL.timestampHeader]: ts,
    [PROTOCOL.signatureHeader]: signatureHex({ ...options, ts }),
  };
}

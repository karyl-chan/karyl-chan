/**
 * Signed HTTP client to the bot's internal API (voice service → bot).
 *
 * Used by the gateway-bridge transport to (a) push OP4 payloads to the bot's
 * `/internal/voice/gateway-send` and (b) tell the bot to stop relaying for a
 * guild on destroy. Reuses the exact bot↔plugin HMAC scheme from
 * @karyl-chan/plugin-sdk so the bot can verify with `verifyDispatchHmac`.
 */
import {
  sign,
  generateNonce,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  NONCE_HEADER,
} from "@karyl-chan/plugin-sdk";

export interface BotClient {
  /** POST a signed JSON body to a bot internal path. Resolves to the HTTP
   *  status; rejects only on a transport/network error. */
  post(path: string, body: unknown): Promise<number>;
}

export function createBotClient(opts: {
  baseUrl: string;
  secret: string;
}): BotClient {
  const base = opts.baseUrl.replace(/\/+$/, "");
  return {
    async post(path, body): Promise<number> {
      const ts = Math.floor(Date.now() / 1000).toString();
      const nonce = generateNonce();
      const raw = JSON.stringify(body ?? {});
      const sig = sign(opts.secret, "POST", path, ts, nonce, raw);
      const res = await fetch(`${base}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [TIMESTAMP_HEADER]: ts,
          [SIGNATURE_HEADER]: sig,
          [NONCE_HEADER]: nonce,
        },
        body: raw,
      });
      return res.status;
    },
  };
}

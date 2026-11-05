import type { IncomingMessage, ServerResponse } from "node:http";

import { createNonceStore } from "./nonce-store.js";
import { signResponse } from "./sign.js";
import type { BehaviorReply, BehaviorWebhookPayload } from "./types.js";
import {
  secretsOf,
  verifyRequest,
  type NonceStore,
  type ReceiverSecrets,
} from "./verify.js";

/**
 * Builds the reply to one verified request; null or undefined for none.
 * `test` marks an admin test-fire: answer it with something harmless.
 */
export type BehaviorAnswer = (
  payload: BehaviorWebhookPayload,
  context: { test: boolean },
) =>
  | BehaviorReply
  | null
  | undefined
  | Promise<BehaviorReply | null | undefined>;

interface ReceiverBase {
  /** The path of the webhook URL as saved on the bot, without the query string. */
  path: string;
  answer: BehaviorAnswer;
  /** A larger request body is refused with 413. Default 1 MiB. */
  maxBodyBytes?: number;
}

export type CreateReceiverOptions =
  | (ReceiverBase & { mode: "none" })
  | (ReceiverBase &
      ReceiverSecrets & {
        // one member for both, so a mode read from config type-checks
        mode: "token" | "hmac";
        /** hmac mode's replay protection. Defaults to a createNonceStore() of its own. */
        nonceStore?: NonceStore;
      });

/**
 * The body, or null once it passes `limit`. Past the limit nothing more is
 * kept, but the rest is still read to its end: answering while the client
 * is still sending makes Node close the socket under it, and the client
 * sees a reset instead of the 413. (A client that never stops sending is
 * cut off by the server's own `requestTimeout`.)
 */
function readBody(req: IncomingMessage, limit: number): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size <= limit) chunks.push(chunk);
      else chunks.length = 0;
    });
    req.on("end", () => resolve(size <= limit ? Buffer.concat(chunks) : null));
    req.on("error", reject);
  });
}

/**
 * A `node:http` request handler for one webhook action: verifies each
 * request (401 when it fails), passes the parsed payload to `answer`, and
 * signs the reply over the request's nonce. A body that is not JSON gets
 * 400, a too-large one 413, and a throwing `answer` 500; none of them
 * stops the handler.
 */
export function createReceiver(
  options: CreateReceiverOptions,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  if (options.mode !== "none" && secretsOf(options).length === 0) {
    throw new TypeError(
      `createReceiver: mode "${options.mode}" needs a non-empty secret`,
    );
  }
  const limit = options.maxBodyBytes ?? 1024 * 1024;
  const verifyOptions =
    options.mode === "none"
      ? options
      : { ...options, nonceStore: options.nonceStore ?? createNonceStore() };

  return async (req, res) => {
    try {
      // A declared length over the limit keeps none of the body (limit -1).
      const declared = Number(req.headers["content-length"]);
      const raw = await readBody(req, declared > limit ? -1 : limit);
      if (raw === null) {
        res.writeHead(413, { connection: "close" }).end();
        return;
      }

      const check = await verifyRequest({
        ...verifyOptions,
        headers: req.headers,
        body: raw,
      });
      if (!check.ok) {
        res.writeHead(401).end();
        return;
      }

      let payload: BehaviorWebhookPayload;
      try {
        payload = JSON.parse(raw.toString("utf8")) as BehaviorWebhookPayload;
      } catch {
        res.writeHead(400).end();
        return;
      }

      const reply = await options.answer(payload, { test: check.test });
      const out = reply ? JSON.stringify(reply) : "";
      // Required in hmac mode; in token mode optional, but verified when sent.
      const signature =
        check.secret !== null && check.nonce !== null
          ? signResponse({
              secret: check.secret,
              path: options.path,
              nonce: check.nonce,
              test: check.test,
              body: out,
            })
          : {};
      res
        .writeHead(200, { "content-type": "application/json", ...signature })
        .end(out);
    } catch {
      // Never let one request crash the process: an async handler's
      // rejection is unhandled, and Node exits on it.
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  };
}

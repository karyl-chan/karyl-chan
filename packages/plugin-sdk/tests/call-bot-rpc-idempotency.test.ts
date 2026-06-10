/**
 * Network-error retry must be gated by idempotency. A `fetch` rejection is
 * ambiguous — the connection can drop (or the timeout fire) AFTER the bot
 * already committed — so retrying a NON-idempotent RPC would duplicate the
 * side effect (double increment, duplicate message). callBotRpc therefore
 * retries network errors only for idempotent paths (NETWORK_RETRY_SAFE_PATHS)
 * and surfaces them immediately for everything else. 503/429 retries (the bot
 * rejected pre-commit) stay unconditional.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import { BotRpcError, callBotRpc } from "../src/server.js";

const silentLog = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  fatal() {},
  trace() {},
  level: "silent",
  child() {
    return silentLog;
  },
} as unknown as FastifyInstance["log"];

const NON_IDEMPOTENT = "/api/plugin/messages.send";
const IDEMPOTENT = "/api/plugin/storage.kv_get";
const MAX_ATTEMPTS = 4; // MAX_RPC_RETRIES (3) + 1

describe("callBotRpc network-error idempotency gating", () => {
  let server: FastifyInstance;
  let hits = 0;
  let mode: "network" | number = "network";

  before(async () => {
    server = Fastify({ logger: false });
    const handler = (_req: unknown, reply: import("fastify").FastifyReply) => {
      hits++;
      if (mode === "network") {
        // Simulate a connection drop AFTER the request was received (the
        // post-commit case): hijack and destroy the socket so the client's
        // fetch rejects with a network error.
        reply.hijack();
        reply.raw.destroy();
        return;
      }
      void reply.code(mode).send({});
    };
    server.post(NON_IDEMPOTENT, handler);
    server.post(IDEMPOTENT, handler);
    await server.listen({ port: 0, host: "127.0.0.1" });
  });
  after(async () => {
    await server.close();
  });

  function url(): string {
    const addr = server.addresses()[0];
    if (!addr || typeof addr === "string") throw new Error("not listening");
    return `http://127.0.0.1:${addr.port}`;
  }

  it("does NOT retry a network error on a non-idempotent path", async () => {
    hits = 0;
    mode = "network";
    await assert.rejects(
      () => callBotRpc(silentLog, url(), "t", NON_IDEMPOTENT, {}),
      (e: unknown) => e instanceof BotRpcError && e.reason === "network",
    );
    assert.equal(hits, 1); // exactly one attempt — pre-fix this retried to 4
  });

  it("DOES retry a network error on an idempotent path", async () => {
    hits = 0;
    mode = "network";
    await assert.rejects(
      () => callBotRpc(silentLog, url(), "t", IDEMPOTENT, {}),
      (e: unknown) => e instanceof BotRpcError && e.reason === "network",
    );
    assert.equal(hits, MAX_ATTEMPTS);
  });

  it("still retries 503 even on a non-idempotent path (pre-commit rejection is safe)", async () => {
    hits = 0;
    mode = 503;
    await assert.rejects(
      () => callBotRpc(silentLog, url(), "t", NON_IDEMPOTENT, {}),
      (e: unknown) => e instanceof BotRpcError,
    );
    assert.equal(hits, MAX_ATTEMPTS); // status-retry unaffected by the network gate
  });
});

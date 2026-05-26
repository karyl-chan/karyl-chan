/**
 * Retry contract for `callBotRpc` (Lockdown L-4):
 *
 *   - 503 / 429 / network failures: retried up to MAX_RPC_RETRIES (3)
 *     with exponential backoff + jitter. Honours Retry-After when set.
 *   - Other 5xx and any 4xx (other than 429): surfaced immediately
 *     (we can't know if the bot already processed the body).
 *   - On exhausted retries, the final BotRpcError carries the last
 *     observed status (or `network` if we never connected).
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import { callBotRpc, BotRpcError } from "../src/server.js";

// A pino-shaped sink we hand to callBotRpc so it doesn't write to stderr
// during tests. The captured logs aren't asserted on, only kept off-band.
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

interface PerAttemptHandler {
  status: number;
  body?: unknown;
  retryAfter?: string;
}

function buildHarness(): {
  server: FastifyInstance;
  url: () => string;
  setScript(steps: PerAttemptHandler[]): void;
  attempts(): number;
} {
  const server = Fastify({ logger: false });
  let script: PerAttemptHandler[] = [];
  let i = 0;
  server.post("/test", async (_req, reply) => {
    const step = script[Math.min(i, script.length - 1)];
    i++;
    if (step.retryAfter) reply.header("Retry-After", step.retryAfter);
    return reply.code(step.status).send(step.body ?? {});
  });
  return {
    server,
    url() {
      const addr = server.addresses()[0];
      if (!addr) throw new Error("server not listening");
      // Fastify resolves 0.0.0.0 to ::1 on some hosts; use 127.0.0.1 to
      // stay deterministic.
      return `http://127.0.0.1:${addr.port}`;
    },
    setScript(steps) {
      script = steps;
      i = 0;
    },
    attempts() {
      return i;
    },
  };
}

describe("callBotRpc retry contract", () => {
  const harness = buildHarness();
  before(async () => {
    await harness.server.listen({ port: 0, host: "127.0.0.1" });
  });
  after(async () => {
    await harness.server.close();
  });

  it("returns the body on first-try success", async () => {
    harness.setScript([{ status: 200, body: { ok: true } }]);
    const result = (await callBotRpc(
      silentLog,
      harness.url(),
      "test-token",
      "/test",
      { ping: 1 },
    )) as { ok: boolean };
    assert.equal(result.ok, true);
    assert.equal(harness.attempts(), 1);
  });

  it("retries on 503 then succeeds", async () => {
    harness.setScript([
      { status: 503 },
      { status: 503 },
      { status: 200, body: { ok: true } },
    ]);
    const result = (await callBotRpc(
      silentLog,
      harness.url(),
      "t",
      "/test",
      {},
    )) as { ok: boolean };
    assert.equal(result.ok, true);
    assert.equal(harness.attempts(), 3);
  });

  it("retries on 429 then succeeds", async () => {
    harness.setScript([
      { status: 429 },
      { status: 200, body: { ok: true } },
    ]);
    await callBotRpc(silentLog, harness.url(), "t", "/test", {});
    assert.equal(harness.attempts(), 2);
  });

  it("does NOT retry on 500 (could have been processed)", async () => {
    harness.setScript([{ status: 500, body: { error: "boom" } }]);
    await assert.rejects(
      () => callBotRpc(silentLog, harness.url(), "t", "/test", {}),
      (err: unknown) =>
        err instanceof BotRpcError &&
        err.reason === "http_status" &&
        err.status === 500,
    );
    assert.equal(harness.attempts(), 1);
  });

  it("does NOT retry on 4xx other than 429", async () => {
    harness.setScript([{ status: 403, body: { error: "denied" } }]);
    await assert.rejects(
      () => callBotRpc(silentLog, harness.url(), "t", "/test", {}),
      (err: unknown) =>
        err instanceof BotRpcError &&
        err.reason === "http_status" &&
        err.status === 403,
    );
    assert.equal(harness.attempts(), 1);
  });

  it("gives up after MAX_RPC_RETRIES on persistent 503", async () => {
    // Script returns 503 forever; harness uses the last step for
    // overflow, so a one-element 503 script covers any attempt count.
    harness.setScript([{ status: 503 }]);
    await assert.rejects(
      () => callBotRpc(silentLog, harness.url(), "t", "/test", {}),
      (err: unknown) =>
        err instanceof BotRpcError &&
        err.reason === "http_status" &&
        err.status === 503 &&
        /after 4 attempts/.test(err.message),
    );
    // Initial attempt + 3 retries = 4.
    assert.equal(harness.attempts(), 4);
  });

  it("retries on network failure (unreachable port) and surfaces network reason", async () => {
    // Port 1 is conventionally unused; connection will refuse fast.
    await assert.rejects(
      () =>
        callBotRpc(silentLog, "http://127.0.0.1:1", "t", "/test", {}),
      (err: unknown) =>
        err instanceof BotRpcError &&
        err.reason === "network" &&
        /after 4 attempts/.test(err.message),
    );
  });

  it("honours Retry-After delta-seconds for 429", async () => {
    // We don't sleep-test exact timings (jitter + CI flake) — we only
    // assert that the retry happens at all and the response is honoured.
    harness.setScript([
      { status: 429, retryAfter: "1" },
      { status: 200, body: { ok: true } },
    ]);
    const start = Date.now();
    await callBotRpc(silentLog, harness.url(), "t", "/test", {});
    const elapsed = Date.now() - start;
    assert.equal(harness.attempts(), 2);
    // Retry-After: 1s. Allow generous slack on the lower bound — the
    // backoff fn caps at RETRY_MAX_MS but a 1s header value should
    // still produce ≥500ms wall time even after clamp.
    assert.ok(
      elapsed >= 500,
      `expected ≥500ms wait honouring Retry-After (got ${elapsed}ms)`,
    );
  });
});

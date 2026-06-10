/**
 * PM-7.2 — lifecycle fetch timeouts.
 *
 * The incident this guards against (2026-06-11, first external plugin
 * author): the bot accepted /api/plugins/register but its handler
 * wedged on a rate-limited Discord call and never answered. The SDK's
 * register fetch had no timeout, so the plugin hung forever with no
 * retry and answered every dispatch 503 ("dispatch HMAC key not
 * available").
 *
 * Contract under test:
 *   - a register call that exceeds the timeout is aborted and treated
 *     as a network error → backoff retry takes over;
 *   - once the bot answers again, registration completes without a
 *     plugin restart;
 *   - a hanging heartbeat is aborted too and does not wedge the loop.
 */

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import Fastify, { type FastifyInstance } from "fastify";
import { startPluginClient, type PluginClient } from "../src/client.js";
import type { PluginManifest } from "../src/manifest.js";

const MANIFEST: PluginManifest = {
  plugin: {
    id: "timeout-test",
    name: "Timeout Test",
    version: "0.0.1",
    url: "http://timeout-test:3000",
  },
} as PluginManifest;

function silentLogger() {
  const entries: Array<{ level: string; msg: string }> = [];
  return {
    entries,
    logger: {
      info: (msg: string) => entries.push({ level: "info", msg }),
      warn: (msg: string) => entries.push({ level: "warn", msg }),
      error: (msg: string) => entries.push({ level: "error", msg }),
    },
  };
}

async function listen(server: FastifyInstance): Promise<string> {
  await server.listen({ port: 0, host: "127.0.0.1" });
  const addr = server.addresses()[0];
  return `http://127.0.0.1:${addr.port}`;
}

const REGISTER_OK = {
  plugin: { id: 1, pluginKey: "timeout-test" },
  token: "tok_test",
  dispatchHmacKey: "hmac_test",
  heartbeat: { path: "/api/plugins/heartbeat", interval_seconds: 1 },
};

describe("plugin client lifecycle timeouts (PM-7.2)", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  after(async () => {
    for (const fn of cleanups.reverse()) await fn();
  });

  it("aborts a wedged register, retries, and recovers when the bot answers", async () => {
    const server = Fastify({ logger: false });
    cleanups.push(() => server.close());
    // First call wedges (replies only after far longer than the client
    // timeout); subsequent calls answer immediately.
    let calls = 0;
    server.post("/api/plugins/register", async (_req, reply) => {
      calls++;
      if (calls === 1) {
        await sleep(5_000);
        return reply.code(200).send(REGISTER_OK);
      }
      return reply.code(200).send(REGISTER_OK);
    });
    const url = await listen(server);

    const { logger, entries } = silentLogger();
    const client: PluginClient = startPluginClient({
      botUrl: url,
      setupSecret: "secret",
      manifest: MANIFEST,
      logger,
      lifecycleTimeoutsMs: { register: 200, heartbeat: 200 },
    });
    cleanups.push(() => client.stop());

    // Backoff base is 2s; the aborted first attempt at ~200ms retries
    // at ~2-2.6s and should then succeed immediately.
    const deadline = Date.now() + 8_000;
    while (client.token() === null && Date.now() < deadline) {
      await sleep(50);
    }

    assert.equal(client.token(), "tok_test", "client recovered after wedge");
    assert.equal(client.getDispatchHmacKey(), "hmac_test");
    assert.ok(calls >= 2, `expected a retry, saw ${calls} register call(s)`);
    assert.ok(
      entries.some(
        (e) => e.level === "warn" && e.msg.includes("register timed out"),
      ),
      "timeout was logged as a timeout (not a generic network error)",
    );
  });

  it("escalates to error after consecutive register timeouts", async () => {
    const server = Fastify({ logger: false });
    cleanups.push(() => server.close());
    server.post("/api/plugins/register", async (_req, reply) => {
      await sleep(5_000);
      return reply.code(200).send(REGISTER_OK);
    });
    const url = await listen(server);

    const { logger, entries } = silentLogger();
    const client = startPluginClient({
      botUrl: url,
      setupSecret: "secret",
      manifest: MANIFEST,
      logger,
      lifecycleTimeoutsMs: { register: 50 },
    });
    cleanups.push(() => client.stop());

    // 3 attempts: ~0s, ~2-2.6s, ~4-5.2s (base backoff 2s, exp + jitter).
    const deadline = Date.now() + 12_000;
    while (
      !entries.some(
        (e) => e.level === "error" && e.msg.includes("likely wedged"),
      ) &&
      Date.now() < deadline
    ) {
      await sleep(100);
    }
    assert.ok(
      entries.some(
        (e) => e.level === "error" && e.msg.includes("likely wedged"),
      ),
      "3rd consecutive timeout escalated to error with diagnosis hint",
    );
  });

  it("aborts a wedged heartbeat without wedging the loop", async () => {
    const server = Fastify({ logger: false });
    cleanups.push(() => server.close());
    let heartbeats = 0;
    server.post("/api/plugins/register", async (_req, reply) =>
      reply.code(200).send(REGISTER_OK),
    );
    server.post("/api/plugins/heartbeat", async (_req, reply) => {
      heartbeats++;
      if (heartbeats === 1) {
        await sleep(5_000);
      }
      return reply.code(200).send({});
    });
    const url = await listen(server);

    const { logger, entries } = silentLogger();
    const client = startPluginClient({
      botUrl: url,
      setupSecret: "secret",
      manifest: MANIFEST,
      logger,
      lifecycleTimeoutsMs: { heartbeat: 100 },
    });
    cleanups.push(() => client.stop());

    // interval_seconds: 1 → first beat ~1s (wedges, aborted at 100ms),
    // second beat ~2s (succeeds). Wait for ≥2 beats.
    const deadline = Date.now() + 8_000;
    while (heartbeats < 2 && Date.now() < deadline) {
      await sleep(50);
    }
    assert.ok(heartbeats >= 2, "heartbeat loop survived the wedged beat");
    assert.ok(
      entries.some(
        (e) => e.level === "warn" && e.msg.includes("heartbeat timed out"),
      ),
      "wedged heartbeat logged as timeout",
    );
  });
});

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import Fastify, { type FastifyInstance } from "fastify";
import { startPluginClient } from "../src/client.js";
import { PluginReadinessError } from "../src/lifecycle.js";
import type { PluginManifest } from "../src/manifest.js";
import { definePlugin } from "../src/plugin.js";

const MANIFEST = {
  plugin: {
    id: "readiness-test",
    name: "Readiness Test",
    version: "0.0.1",
    url: "http://readiness-test:3000",
  },
} as PluginManifest;

async function listen(server: FastifyInstance): Promise<string> {
  await server.listen({ port: 0, host: "127.0.0.1" });
  const addr = server.addresses()[0];
  return `http://127.0.0.1:${addr.port}`;
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await sleep(10);
  assert.equal(
    predicate(),
    true,
    "condition did not become true before timeout",
  );
}

function registerResponse() {
  return {
    token: "token",
    dispatchHmacKey: "hmac",
    heartbeat: { interval_seconds: 999 },
    readiness: { required: true, path: "/api/plugins/ready" },
    eventTransport: { selected: "http", consumerRequired: false },
  };
}

describe("readiness-v1 lifecycle", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  after(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup();
  });

  it("stays initializing until onFirstRegister completes and bot acknowledges ready", async () => {
    const server = Fastify({ logger: false });
    let readyCalls = 0;
    let registerBody: Record<string, unknown> | null = null;
    server.post("/api/plugins/register", async (request, reply) => {
      registerBody = request.body as Record<string, unknown>;
      return reply.send(registerResponse());
    });
    server.post("/api/plugins/ready", async () => {
      readyCalls++;
      return { ok: true };
    });
    const url = await listen(server);
    cleanups.push(() => server.close());

    let finishInitialization!: () => void;
    const initializationGate = new Promise<void>((resolve) => {
      finishInitialization = resolve;
    });
    const client = startPluginClient({
      botUrl: url,
      setupSecret: "secret",
      manifest: MANIFEST,
      logger: { info() {}, warn() {}, error() {} },
      onFirstRegister: () => initializationGate,
    });
    cleanups.push(() => client.stop());

    await waitFor(() => client.lifecycleState() === "initializing");
    assert.equal(readyCalls, 0);
    const observedRegisterBody = registerBody as Record<string, unknown> | null;
    assert.deepEqual(
      observedRegisterBody?.lifecycle as Record<string, unknown> | undefined,
      { readiness: "v1" },
    );
    assert.deepEqual(observedRegisterBody?.eventTransports, {
      available: ["http"],
    });

    finishInitialization();
    await client.whenReady();
    assert.equal(client.lifecycleState(), "ready");
    assert.equal(readyCalls, 1);
  });

  it("fails closed, rejects readiness, and deregisters when initialization throws", async () => {
    const server = Fastify({ logger: false });
    let readyCalls = 0;
    let heartbeatCalls = 0;
    let deregisterCalls = 0;
    server.post("/api/plugins/register", async (_request, reply) =>
      reply.send(registerResponse()),
    );
    server.post("/api/plugins/ready", async () => {
      readyCalls++;
      return { ok: true };
    });
    server.post("/api/plugins/heartbeat", async () => {
      heartbeatCalls++;
      return { ok: true };
    });
    server.post("/api/plugins/deregister", async () => {
      deregisterCalls++;
      return { ok: true };
    });
    const url = await listen(server);
    cleanups.push(() => server.close());

    const original = new Error("database migration failed");
    const client = startPluginClient({
      botUrl: url,
      setupSecret: "secret",
      manifest: MANIFEST,
      logger: { info() {}, warn() {}, error() {} },
      onFirstRegister: async () => {
        throw original;
      },
    });
    cleanups.push(() => client.stop());

    await assert.rejects(client.whenReady(), (error) => error === original);
    await waitFor(() => deregisterCalls === 1);
    assert.equal(client.lifecycleState(), "failed");
    assert.equal(readyCalls, 0);
    assert.equal(heartbeatCalls, 0);
  });

  it("treats a transport mismatch as a permanent readiness failure", async () => {
    const server = Fastify({ logger: false });
    let registerCalls = 0;
    server.post("/api/plugins/register", async (_request, reply) => {
      registerCalls++;
      return reply.code(409).send({
        code: "event_transport_unavailable",
        error: "REDIS_URL is not set",
        selectedTransport: "redis-streams",
      });
    });
    const url = await listen(server);
    cleanups.push(() => server.close());
    const client = startPluginClient({
      botUrl: url,
      setupSecret: "secret",
      manifest: MANIFEST,
      logger: { info() {}, warn() {}, error() {} },
    });
    cleanups.push(() => client.stop());

    await assert.rejects(client.whenReady(), /REDIS_URL is not set/);
    await sleep(50);
    assert.equal(client.lifecycleState(), "failed");
    assert.equal(registerCalls, 1);
  });

  it("re-applies the bot selection on re-register without re-running onStart", async () => {
    const server = Fastify({ logger: false });
    let registerCalls = 0;
    let heartbeatCalls = 0;
    let firstRegisterCalls = 0;
    const selections: string[] = [];
    server.post("/api/plugins/register", async (_request, reply) => {
      registerCalls++;
      return reply.send({
        ...registerResponse(),
        heartbeat: { interval_seconds: 0.02 },
        eventTransport:
          registerCalls === 1
            ? { selected: "http", consumerRequired: false }
            : { selected: "redis-streams", consumerRequired: true },
      });
    });
    server.post("/api/plugins/ready", async () => ({ ok: true }));
    server.post("/api/plugins/heartbeat", async (_request, reply) => {
      heartbeatCalls++;
      if (heartbeatCalls === 1) return reply.code(401).send();
      return reply.send({ ok: true });
    });
    server.post("/api/plugins/deregister", async () => ({ ok: true }));
    const url = await listen(server);
    cleanups.push(() => server.close());

    const client = startPluginClient({
      botUrl: url,
      setupSecret: "secret",
      manifest: MANIFEST,
      eventTransports: { available: ["http", "redis-streams"] },
      logger: { info() {}, warn() {}, error() {} },
      onFirstRegister: () => {
        firstRegisterCalls++;
      },
      onEventTransportSelected: (selection) => {
        selections.push(selection.selected);
      },
    });
    cleanups.push(() => client.stop());

    await client.whenReady();
    await waitFor(() => selections.length === 2);
    assert.deepEqual(selections, ["http", "redis-streams"]);
    assert.equal(firstRegisterCalls, 1);
    assert.equal(registerCalls, 2);
    assert.equal(client.lifecycleState(), "ready");
  });

  it("keeps intentional no-secret startup live but explicitly serving dark", async () => {
    const plugin = definePlugin({
      key: "dark-mode-test",
      name: "Dark Mode Test",
      version: "0.0.1",
      rpcMethodsUsed: [],
      storage: { guildKv: false },
    });
    const started = await plugin.start({
      port: 0,
      host: "127.0.0.1",
      setupSecret: "",
      pluginUrl: "http://dark-mode-test:3000",
    });
    try {
      assert.equal(started.lifecycleState(), "serving_dark");
      const live = await started.server.inject({
        method: "GET",
        url: "/health",
      });
      assert.equal(live.statusCode, 200);
      const ready = await started.server.inject({
        method: "GET",
        url: "/health/ready",
      });
      assert.equal(ready.statusCode, 503);
      assert.equal(ready.json().state, "serving_dark");
      await assert.rejects(
        started.whenReady(),
        (error) =>
          error instanceof PluginReadinessError &&
          error.state === "serving_dark",
      );
    } finally {
      await started.stop();
    }
  });
});

/**
 * PluginDispatchPool — circuit breaker + concurrency limit + retry on
 * connect-refused. Uses a real ephemeral HTTP server so undici's pool
 * + retry semantics are exercised end-to-end.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  PluginDispatchPool,
  DEFAULT_DISPATCH_POOL_OPTIONS,
  type DispatchOutcome,
} from "../src/modules/plugin-system/plugin-dispatch-pool.js";

interface Harness {
  server: Server;
  port: number;
  url: string;
  // Behaviour switches set per test.
  status: number;
  hangMs: number;
  closeOnConnect: boolean;
  requestCount: number;
}

async function startServer(): Promise<Harness> {
  const h: Harness = {
    server: null as unknown as Server,
    port: 0,
    url: "",
    status: 200,
    hangMs: 0,
    closeOnConnect: false,
    requestCount: 0,
  };
  h.server = createServer((req, res) => {
    h.requestCount++;
    if (h.closeOnConnect) {
      req.socket.destroy();
      return;
    }
    const finish = () => {
      res.statusCode = h.status;
      res.end(JSON.stringify({ ok: h.status < 400 }));
    };
    if (h.hangMs > 0) {
      setTimeout(finish, h.hangMs).unref();
    } else {
      finish();
    }
  });
  await new Promise<void>((resolve) => h.server.listen(0, "127.0.0.1", resolve));
  const addr = h.server.address() as AddressInfo;
  h.port = addr.port;
  h.url = `http://127.0.0.1:${h.port}/events`;
  return h;
}

async function stopServer(h: Harness): Promise<void> {
  await new Promise<void>((resolve) => h.server.close(() => resolve()));
}

describe("PluginDispatchPool", () => {
  let h: Harness;
  let pool: PluginDispatchPool;

  beforeEach(async () => {
    h = await startServer();
  });

  afterEach(async () => {
    await pool?.stop();
    await stopServer(h);
  });

  it("delivers a 2xx outcome on success and counts it as not-a-failure", async () => {
    pool = new PluginDispatchPool();
    const r = (await pool.post(
      "p1",
      h.url,
      { "x-foo": "1" },
      JSON.stringify({ type: "x" }),
    )) as DispatchOutcome;
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.status).toBe(200);
    const snap = pool.snapshot();
    expect(snap[0]?.consecutiveFailures).toBe(0);
  });

  it("trips the breaker after BREAKER_THRESHOLD consecutive failures", async () => {
    pool = new PluginDispatchPool({
      ...DEFAULT_DISPATCH_POOL_OPTIONS,
      breakerThreshold: 3,
      breakerOpenMs: 60_000,
      requestTimeoutMs: 500,
    });
    h.status = 500;
    for (let i = 0; i < 3; i++) {
      const r = await pool.post("p1", h.url, {}, "{}");
      expect(r.ok).toBe(false);
    }
    // 4th call should be short-circuited by the breaker.
    const r4 = await pool.post("p1", h.url, {}, "{}");
    expect(r4).toMatchObject({ ok: false, reason: "breaker_open" });
    // 4th call should NOT have reached the server (request count
    // stayed at 3).
    expect(h.requestCount).toBe(3);
  });

  it("breaker closes after a successful half-open probe", async () => {
    pool = new PluginDispatchPool({
      ...DEFAULT_DISPATCH_POOL_OPTIONS,
      breakerThreshold: 2,
      breakerOpenMs: 50,
      requestTimeoutMs: 500,
    });
    h.status = 500;
    await pool.post("p1", h.url, {}, "{}");
    await pool.post("p1", h.url, {}, "{}");
    // Wait past the open window.
    await new Promise((r) => setTimeout(r, 80));
    // Flip to healthy. Probe should succeed and close the breaker.
    h.status = 200;
    const probe = await pool.post("p1", h.url, {}, "{}");
    expect(probe.ok).toBe(true);
    const followup = await pool.post("p1", h.url, {}, "{}");
    expect(followup.ok).toBe(true);
  });

  it("retries once on connect-refused (covers plugin recreate gap)", async () => {
    // Use a port we know nothing is listening on for the first call.
    const deadPort = h.port + 1;
    const deadUrl = `http://127.0.0.1:${deadPort}/events`;
    pool = new PluginDispatchPool({
      ...DEFAULT_DISPATCH_POOL_OPTIONS,
      connectRetryDelayMs: 50,
    });
    const r = await pool.post("p1", deadUrl, {}, "{}");
    // Both attempts refused → outcome is connect_refused. The retry
    // delay was small so the test still completes quickly.
    expect(r).toMatchObject({ ok: false, reason: "connect_refused" });
  });

  it("sheds when the per-plugin in-flight cap is hit", async () => {
    pool = new PluginDispatchPool({
      ...DEFAULT_DISPATCH_POOL_OPTIONS,
      maxInFlight: 2,
      requestTimeoutMs: 2_000,
    });
    h.hangMs = 200;
    // Fire 4 in parallel. First 2 go to the server; 3+4 shed immediately.
    const calls = Array.from({ length: 4 }, () =>
      pool.post("p1", h.url, {}, "{}"),
    );
    const outcomes = await Promise.all(calls);
    const shed = outcomes.filter(
      (o) => !o.ok && o.reason === "shed",
    );
    expect(shed.length).toBe(2);
  });

  it("snapshot reports per-plugin inFlight / breaker / failure count", async () => {
    pool = new PluginDispatchPool({
      ...DEFAULT_DISPATCH_POOL_OPTIONS,
      breakerThreshold: 2,
      requestTimeoutMs: 500,
    });
    h.status = 500;
    await pool.post("p1", h.url, {}, "{}");
    await pool.post("p1", h.url, {}, "{}");
    const snap = pool.snapshot();
    expect(snap[0]).toMatchObject({
      pluginKey: "p1",
      inFlight: 0,
      consecutiveFailures: 2,
      breakerOpen: true,
    });
  });

  it("drop closes the pool and forgets per-plugin state", async () => {
    pool = new PluginDispatchPool();
    await pool.post("p1", h.url, {}, "{}");
    expect(pool.snapshot().length).toBe(1);
    pool.drop("p1");
    expect(pool.snapshot().length).toBe(0);
  });
});

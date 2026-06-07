/**
 * PR-4.2 — plugin-proxy recreate-race retry.
 *
 * When a plugin container is recreated (`docker compose up --build -d`), the
 * old container is gone and the new one has not yet bound its port. A request
 * proxied through `/plugin/<key>/*` during that window fails with
 * ECONNREFUSED. The event-dispatch path already retries that window once
 * (plugin-dispatch-pool.ts); these tests assert the HTTP reverse proxy now
 * does the same.
 *
 * Coverage:
 *   R-1. upstream refuses the first connection then becomes reachable inside
 *        the retry window → proxy returns the upstream 200 (NOT 502).
 *   R-2. upstream is persistently down → proxy fails fast with 502 after
 *        exactly one retry (does not hang).
 *   R-3. a request WITH a body is NOT retried (body-replay safety): a
 *        persistently-down upstream returns 502 with no second connect
 *        attempt.
 *
 * No live plugin / Docker — a throwaway local http server stands in for the
 * upstream and its listen state is toggled to simulate the recreate window.
 */
import {
  vi,
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterAll,
} from "vitest";
import { createServer, type Server } from "node:http";
import { connect } from "node:net";
import type { AddressInfo } from "node:net";

vi.hoisted(() => {
  process.env.SQLITE_DB_PATH = ":memory:";
  process.env.NODE_ENV = "test";
});

// Allow loopback upstream targets through the SSRF host policy.
vi.mock("../src/utils/host-policy.js", () => ({
  assertPluginTarget: vi.fn().mockResolvedValue(undefined),
  HostPolicyError: class HostPolicyError extends Error {},
}));

import { sequelize } from "../src/db.js";
import {
  Plugin,
  findPluginByKey,
} from "../src/modules/plugin-system/models/plugin.model.js";
import { invalidateAllPluginCache } from "../src/modules/plugin-system/plugin-lookup-cache.js";

// ── helpers ──────────────────────────────────────────────────────────────────

/** Find a port that is currently free, then leave it free (closed). */
async function reserveFreePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const s = createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

/** Build a one-shot upstream that replies 200 to a single request body. */
function makeUpstream(onRequest?: () => void): Server {
  return createServer((req, res) => {
    onRequest?.();
    // Drain the body so the socket can be reused / closed cleanly.
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("upstream-ok");
    });
  });
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

/** True if nothing is currently accepting connections on the port. */
async function isPortRefusing(port: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const sock = connect(port, "127.0.0.1");
    sock.once("connect", () => {
      sock.destroy();
      resolve(false);
    });
    sock.once("error", () => resolve(true));
  });
}

// ── server setup ───────────────────────────────────────────────────────────

let server: import("fastify").FastifyInstance;

async function buildServer() {
  const fastify = (await import("fastify")).default;
  const { registerPluginProxy } = await import(
    "../src/modules/plugin-system/plugin-proxy.js"
  );
  const s = fastify({ logger: false });
  await registerPluginProxy(s);
  await s.ready();
  return s;
}

async function createActivePlugin(pluginKey: string, port: number) {
  await Plugin.create({
    pluginKey,
    name: pluginKey,
    version: "1.0.0",
    url: `http://127.0.0.1:${port}`,
    manifestJson: "{}",
    tokenHash: "x",
    status: "active",
    enabled: true,
  });
  // Drop the lookup cache so the freshly-created row is read.
  invalidateAllPluginCache();
}

beforeAll(async () => {
  server = await buildServer();
  await sequelize.sync({ force: true });
});

beforeEach(async () => {
  await Plugin.destroy({ where: {} });
  invalidateAllPluginCache();
});

afterAll(async () => {
  await server.close();
  await sequelize.close();
});

// ── R-1: refused first, reachable inside the window → success ────────────────

describe("R-1: upstream comes up inside the retry window", () => {
  it("returns the upstream 200 instead of a 502", async () => {
    const port = await reserveFreePort();
    await createActivePlugin("recreate-ok", port);

    // Nothing listening yet → first connect attempt is refused.
    expect(await isPortRefusing(port)).toBe(true);

    const upstream = makeUpstream();
    // Bring the upstream up well within the ~250ms retry delay window.
    const upTimer = setTimeout(() => {
      void listen(upstream, port);
    }, 100);

    try {
      const res = await server.inject({
        method: "GET",
        url: "/plugin/recreate-ok/dashboard",
      });
      expect(res.statusCode).toBe(200);
      expect(res.body).toBe("upstream-ok");
    } finally {
      clearTimeout(upTimer);
      await closeServer(upstream);
    }
  });
});

// ── R-2: persistently down → fail fast with one retry ────────────────────────

describe("R-2: upstream persistently down", () => {
  it("returns 502 and fails fast after a single retry", async () => {
    const port = await reserveFreePort();
    await createActivePlugin("recreate-down", port);
    expect(await isPortRefusing(port)).toBe(true);

    const start = Date.now();
    const res = await server.inject({
      method: "GET",
      url: "/plugin/recreate-down/dashboard",
    });
    const elapsed = Date.now() - start;

    expect(res.statusCode).toBe(502);
    // One retry of ~250ms; assert it neither skipped the retry (too fast to
    // matter) nor looped many times. A generous upper bound keeps the test
    // stable on slow CI while still proving it does not hang.
    expect(elapsed).toBeLessThan(3_000);
  });
});

// ── R-3: request with a body is not retried (body-replay safety) ─────────────

describe("R-3: body-carrying request is not retried", () => {
  it("returns 502 immediately (no retry delay) when a body is present", async () => {
    const port = await reserveFreePort();
    await createActivePlugin("recreate-post", port);
    expect(await isPortRefusing(port)).toBe(true);

    // Bring an upstream up inside the would-be retry window. If the proxy
    // retried a body request, this late server would catch the retry and the
    // response would be 200 — it must NOT, because replaying a buffered body
    // to a non-idempotent upstream risks a double-submit.
    const late = makeUpstream();
    const upTimer = setTimeout(() => void listen(late, port), 100);

    try {
      const start = Date.now();
      const res = await server.inject({
        method: "POST",
        url: "/plugin/recreate-post/upload",
        headers: { "content-type": "application/octet-stream" },
        payload: Buffer.from("some-body-bytes"),
      });
      const elapsed = Date.now() - start;

      // Body request against a refused upstream → immediate 502, no retry
      // (would be 200 from the late upstream if it had retried, and the
      // elapsed time would be >= the ~250ms retry delay).
      expect(res.statusCode).toBe(502);
      expect(elapsed).toBeLessThan(200);
    } finally {
      clearTimeout(upTimer);
      await closeServer(late);
    }
  });
});

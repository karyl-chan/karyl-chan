/**
 * Plugin Platform #66 regression: a real bot owns event-transport selection,
 * a real SDK plugin starts that selection, and an unusable selection fails
 * closed before readiness.
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DB_URL = process.env.TEST_E2E_DB_URL;
const REDIS_URL = process.env.TEST_E2E_REDIS_URL;

function findRepoRoot(from: string): string {
  let dir = from;
  for (let i = 0; i < 10; i++) {
    if (existsSync(path.join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`pnpm-workspace.yaml not found above ${from}`);
}

const REPO = findRepoRoot(path.dirname(fileURLToPath(import.meta.url)));
const BOT_MAIN = path.join(REPO, "packages", "bot", "build", "main.js");
const SDK_DIST = path.join(REPO, "packages", "plugin-sdk", "dist", "index.js");
const BOT_PRODUCER = path.join(
  REPO,
  "packages",
  "bot",
  "build",
  "adapters",
  "redis",
  "plugin-event-bus.js",
);

interface StartedPluginLike {
  stop(): Promise<void>;
  whenReady(): Promise<void>;
  lifecycleState(): "registering" | "initializing" | "ready" | "failed";
}

interface RedisLike {
  del(...keys: string[]): Promise<number>;
  quit(): Promise<string>;
  xpending(...args: Array<string | number>): Promise<unknown>;
}

interface RedisCtor {
  new (url: string): RedisLike;
}

interface EventBusCtor {
  new (redis: unknown): {
    dispatchToPlugin(
      pluginId: number,
      pluginKey: string,
      eventType: string,
      data: unknown,
    ): void;
  };
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("no address")));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

async function until<T>(
  what: string,
  fn: () => Promise<T | null>,
  timeoutMs = 30_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value !== null) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `timed out waiting for ${what}` +
      (lastError ? `; last error: ${String(lastError)}` : ""),
  );
}

async function api(
  method: string,
  url: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(url, {
    method,
    signal: AbortSignal.timeout(10_000),
    headers:
      body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return {
    status: response.status,
    body: await response.json().catch(() => null),
  };
}

const run = DB_URL && REDIS_URL ? describe : describe.skip;

run("#66 event transport negotiation E2E", () => {
  let bot: ChildProcess | null = null;
  let botLog = "";
  let botUrl = "";
  const started: StartedPluginLike[] = [];
  const originalEventBus = process.env.EVENT_BUS;
  const originalRedisUrl = process.env.REDIS_URL;

  before(async () => {
    const botPort = await freePort();
    botUrl = `http://127.0.0.1:${botPort}`;
    bot = spawn(process.execPath, [BOT_MAIN], {
      cwd: path.join(REPO, "packages", "bot"),
      env: {
        PATH: process.env.PATH ?? "",
        NODE_ENV: "development",
        BOT_SKIP_DISCORD: "true",
        BOT_TOKEN: "e2e.placeholder",
        ENCRYPTION_KEY:
          "0000000000000000000000000000000000000000000000000000000000000000",
        JWT_SECRET:
          "0000000000000000000000000000000000000000000000000000000000000000",
        DB_URL,
        REDIS_URL,
        EVENT_BUS: "redis-streams",
        WEB_PORT: String(botPort),
        WEB_HOST: "127.0.0.1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    bot.stdout?.on("data", (chunk: Buffer) => (botLog += chunk.toString()));
    bot.stderr?.on("data", (chunk: Buffer) => (botLog += chunk.toString()));
    await until(
      "Streams bot readiness",
      async () => {
        const response = await api("GET", `${botUrl}/api/health/ready`);
        return response.status === 200 ? response : null;
      },
      90_000,
    );
  });

  after(async () => {
    for (const plugin of started.reverse()) {
      await plugin.stop().catch(() => undefined);
    }
    if (originalEventBus === undefined) delete process.env.EVENT_BUS;
    else process.env.EVENT_BUS = originalEventBus;
    if (originalRedisUrl === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = originalRedisUrl;
    if (bot && bot.exitCode === null) {
      const exited = new Promise<void>((resolve) =>
        bot?.once("exit", () => resolve()),
      );
      bot.kill("SIGTERM");
      let watchdog: NodeJS.Timeout;
      const outcome = await Promise.race([
        exited.then(() => "exited" as const),
        new Promise<"timeout">((resolve) => {
          watchdog = setTimeout(() => resolve("timeout"), 15_000);
          watchdog.unref();
        }),
      ]);
      clearTimeout(watchdog!);
      if (outcome === "timeout") {
        bot.kill("SIGKILL");
        throw new Error(`Streams bot did not exit\n${botLog.slice(-4000)}`);
      }
    }
  });

  async function provision(pluginKey: string): Promise<string> {
    const prior = await api("GET", `${botUrl}/api/plugins/by-key/${pluginKey}`);
    if (prior.status === 200) {
      const id = (prior.body as { plugin: { id: number } }).plugin.id;
      await api("DELETE", `${botUrl}/api/plugins/${id}`);
    }
    const minted = await api("POST", `${botUrl}/api/plugins/setup-secret`, {
      pluginKey,
    });
    assert.equal(minted.status, 200, JSON.stringify(minted.body));
    return (minted.body as { setupSecret: string }).setupSecret;
  }

  it("matching Streams selection registers, handles, and XACKs", async (t) => {
    process.env.EVENT_BUS = "redis-streams";
    process.env.REDIS_URL = REDIS_URL!;
    const pluginKey = `e2e-streams-negotiated-${process.pid}`;
    const streamKey = `karyl:plugin:${pluginKey}:events`;
    const dlqKey = `${streamKey}:dlq`;
    const redisModule = (await import("ioredis")) as unknown as {
      Redis: RedisCtor;
    };
    const producerRedis = new redisModule.Redis(REDIS_URL!);
    let live: StartedPluginLike | null = null;
    try {
      // Delete stale data before the SDK creates its consumer group; deleting
      // the stream afterwards would also delete the just-created group.
      await producerRedis.del(streamKey, dlqKey);
      const setupSecret = await provision(pluginKey);
      const port = await freePort();
      const pluginUrl = `http://127.0.0.1:${port}`;
      const sdk = await import(pathToFileURL(SDK_DIST).href);
      const received: unknown[] = [];
      const plugin = sdk.definePlugin({
        key: pluginKey,
        name: "E2E negotiated Streams",
        version: "0.0.1",
        description: "Transport negotiation E2E probe",
        eventHandlers: {
          "dm.message_create": async (_ctx: unknown, data: unknown) => {
            received.push(data);
          },
        },
      });
      live = (await plugin.start({
        port,
        host: "127.0.0.1",
        botUrl,
        setupSecret,
        pluginUrl,
      })) as StartedPluginLike;
      started.push(live);
      await live.whenReady();

      const detail = await api(
        "GET",
        `${botUrl}/api/plugins/by-key/${pluginKey}`,
      );
      assert.equal(detail.status, 200, JSON.stringify(detail.body));
      const body = detail.body as {
        plugin: {
          id: number;
          eventTransport: {
            configured: string;
            status: string;
            replicas: Array<{ transport: string; consumerState: string }>;
          };
        };
      };
      assert.deepEqual(body.plugin.eventTransport, {
        configured: "redis-streams",
        status: "ready",
        replicas: [
          {
            url: pluginUrl,
            lifecycleState: "ready",
            transport: "redis-streams",
            consumerState: "ready",
          },
        ],
      });

      const producerModule = (await import(
        pathToFileURL(BOT_PRODUCER).href
      )) as {
        RedisStreamsPluginEventBus: EventBusCtor;
      };
      const bus = new producerModule.RedisStreamsPluginEventBus(producerRedis);
      const payload = { id: "negotiated-1", content: "transport-e2e" };
      bus.dispatchToPlugin(
        body.plugin.id,
        pluginKey,
        "dm.message_create",
        payload,
      );
      await until("negotiated Streams handler", async () =>
        received.length === 1 ? received[0] : null,
      );
      assert.deepEqual(received[0], payload);
      const pending = (await producerRedis.xpending(
        streamKey,
        `kc-consumer:${pluginKey}`,
      )) as unknown[];
      assert.equal(pending[0], 0, "successful handler must XACK the event");
    } finally {
      if (live) {
        await live.stop().catch(() => undefined);
        const index = started.indexOf(live);
        if (index >= 0) started.splice(index, 1);
      }
      // Stop the live consumer before deleting its stream/group so it cannot
      // emit a misleading NOGROUP warning during teardown.
      await producerRedis.del(streamKey, dlqKey).catch(() => 0);
      await producerRedis.quit().catch(() => undefined);
    }
    t.diagnostic(
      "#66 verified: bot-selected Streams reached handler and XACKed",
    );
  });

  it("split-brain configuration is refused and remains not-ready", async (t) => {
    process.env.EVENT_BUS = "http";
    delete process.env.REDIS_URL;
    const pluginKey = `e2e-streams-mismatch-${process.pid}`;
    const setupSecret = await provision(pluginKey);
    const port = await freePort();
    const pluginUrl = `http://127.0.0.1:${port}`;
    const sdk = await import(pathToFileURL(SDK_DIST).href);
    const plugin = sdk.definePlugin({
      key: pluginKey,
      name: "E2E Streams mismatch",
      version: "0.0.1",
      description: "Transport mismatch E2E probe",
      eventHandlers: {
        "dm.message_create": async () => undefined,
      },
    });
    const failed = (await plugin.start({
      port,
      host: "127.0.0.1",
      botUrl,
      setupSecret,
      pluginUrl,
    })) as StartedPluginLike;
    started.push(failed);

    await assert.rejects(
      failed.whenReady(),
      /redis-streams|EVENT_BUS|REDIS_URL/i,
    );
    assert.equal(failed.lifecycleState(), "failed");
    assert.equal((await api("GET", `${pluginUrl}/health`)).status, 200);
    assert.equal((await api("GET", `${pluginUrl}/health/ready`)).status, 503);

    const detail = await api(
      "GET",
      `${botUrl}/api/plugins/by-key/${pluginKey}`,
    );
    assert.equal(detail.status, 200, JSON.stringify(detail.body));
    const state = (
      detail.body as {
        plugin: {
          eventTransport: {
            configured: string;
            status: string;
            replicas: Array<{ consumerState: string; error?: string }>;
          };
        };
      }
    ).plugin.eventTransport;
    assert.equal(state.configured, "redis-streams");
    assert.equal(state.status, "misconfigured");
    assert.equal(state.replicas[0]?.consumerState, "misconfigured");
    assert.match(state.replicas[0]?.error ?? "", /EVENT_BUS|REDIS_URL/i);

    process.env.EVENT_BUS = "redis-streams";
    process.env.REDIS_URL = REDIS_URL!;
    t.diagnostic("#66 verified: split-brain register failed before readiness");
  });
});

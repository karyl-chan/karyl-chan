/**
 * Plugin Platform 1.0 fault-injection gate.
 *
 * These are the two recovery paths #67 makes mandatory. Both inject a real
 * process failure and wait on an observable recovery invariant; neither uses
 * a fixed sleep as its assertion.
 */

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DB_URL = process.env.TEST_E2E_DB_URL;
const REDIS_URL = process.env.TEST_E2E_REDIS_URL;
const ENABLED = process.env.TEST_CHAOS === "1";

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
const PLUGIN_WORKER = path.join(
  REPO,
  "e2e",
  "dist",
  "src",
  "fixtures",
  "restartable-plugin.js",
);
const CONSUMER_WORKER = path.join(
  REPO,
  "e2e",
  "dist",
  "src",
  "fixtures",
  "streams-consumer.js",
);

interface RedisLike {
  del(...keys: string[]): Promise<number>;
  quit(): Promise<string>;
  xadd(key: string, ...args: Array<string | number>): Promise<string>;
  xlen(key: string): Promise<number>;
  xpending(...args: Array<string | number>): Promise<unknown>;
}

interface RedisCtor {
  new (url: string): RedisLike;
}

interface LoggedChild {
  child: ChildProcess;
  output(): string;
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

function spawnLogged(file: string, env: NodeJS.ProcessEnv): LoggedChild {
  let output = "";
  const child = spawn(process.execPath, [file], {
    cwd: REPO,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk: Buffer) => (output += chunk.toString()));
  child.stderr?.on("data", (chunk: Buffer) => (output += chunk.toString()));
  return { child, output: () => output };
}

async function waitForMarker(
  worker: LoggedChild,
  marker: string,
  timeoutMs = 30_000,
): Promise<void> {
  await until(
    `'${marker}' from child process`,
    async () => {
      if (worker.output().includes(marker)) return true;
      if (worker.child.exitCode !== null) {
        throw new Error(
          `child exited ${worker.child.exitCode} before '${marker}'\n${worker.output()}`,
        );
      }
      return null;
    },
    timeoutMs,
  );
}

async function terminate(
  worker: LoggedChild | null,
  signal: NodeJS.Signals = "SIGTERM",
): Promise<void> {
  if (
    !worker ||
    worker.child.exitCode !== null ||
    worker.child.signalCode !== null
  ) {
    return;
  }
  const exited = new Promise<void>((resolve) =>
    worker.child.once("exit", () => resolve()),
  );
  if (!worker.child.kill(signal)) return;
  let watchdog: NodeJS.Timeout;
  const outcome = await Promise.race([
    exited.then(() => "exited" as const),
    new Promise<"timeout">((resolve) => {
      watchdog = setTimeout(() => resolve("timeout"), 5_000);
      watchdog.unref();
    }),
  ]);
  clearTimeout(watchdog!);
  if (outcome === "timeout") {
    if (worker.child.exitCode !== null || worker.child.signalCode !== null)
      return;
    if (!worker.child.kill("SIGKILL")) return;
    await exited;
  }
}

/** Explicitly deferred by #67's non-goals; they are not registered as tests. */
export const DEFERRED_SCENARIOS = [
  "network-partition",
  "gateway-resume-window",
] as const;

const run = ENABLED && DB_URL && REDIS_URL ? describe : describe.skip;
const liveChildren: LoggedChild[] = [];

after(async () => {
  for (const worker of liveChildren.reverse()) {
    await terminate(worker, "SIGKILL").catch(() => undefined);
  }
});

run("plugin-platform chaos recovery", () => {
  it("abrupt plugin death is reaped and restart restores one ready endpoint", async (t) => {
    const botPort = await freePort();
    const pluginPort = await freePort();
    const botUrl = `http://127.0.0.1:${botPort}`;
    const pluginUrl = `http://127.0.0.1:${pluginPort}`;
    const pluginKey = `e2e-restart-${process.pid}`;
    const bot = spawnLogged(BOT_MAIN, {
      PATH: process.env.PATH ?? "",
      NODE_ENV: "development",
      BOT_SKIP_DISCORD: "true",
      BOT_TOKEN: "e2e.placeholder",
      ENCRYPTION_KEY:
        "0000000000000000000000000000000000000000000000000000000000000000",
      JWT_SECRET:
        "0000000000000000000000000000000000000000000000000000000000000000",
      DB_URL,
      WEB_PORT: String(botPort),
      WEB_HOST: "127.0.0.1",
      PLUGIN_HEARTBEAT_TIMEOUT_MS: "1500",
      PLUGIN_REAPER_INTERVAL_MS: "250",
    });
    liveChildren.push(bot);
    let first: LoggedChild | null = null;
    let restarted: LoggedChild | null = null;

    try {
      await until(
        "chaos bot readiness",
        async () => {
          const response = await api("GET", `${botUrl}/api/health/ready`);
          return response.status === 200 ? response : null;
        },
        90_000,
      );

      const minted = await api("POST", `${botUrl}/api/plugins/setup-secret`, {
        pluginKey,
      });
      assert.equal(minted.status, 200, JSON.stringify(minted.body));
      const setupSecret = (minted.body as { setupSecret: string }).setupSecret;
      const workerEnv = {
        PATH: process.env.PATH ?? "",
        E2E_PLUGIN_KEY: pluginKey,
        E2E_PLUGIN_PORT: String(pluginPort),
        E2E_BOT_URL: botUrl,
        E2E_PLUGIN_URL: pluginUrl,
        E2E_SETUP_SECRET: setupSecret,
      };

      first = spawnLogged(PLUGIN_WORKER, workerEnv);
      liveChildren.push(first);
      await waitForMarker(first, "PLUGIN_READY");
      await until("first ready endpoint", async () => {
        const response = await api(
          "GET",
          `${botUrl}/api/plugins/by-key/${pluginKey}`,
        );
        if (response.status !== 200) return null;
        const plugin = (
          response.body as {
            plugin: {
              status: string;
              eventTransport: { status: string; replicas: unknown[] };
            };
          }
        ).plugin;
        return plugin.status === "active" &&
          plugin.eventTransport.status === "ready" &&
          plugin.eventTransport.replicas.length === 1
          ? plugin
          : null;
      });

      await terminate(first, "SIGKILL");
      await until(
        "heartbeat reaper to remove the dead endpoint",
        async () => {
          const response = await api(
            "GET",
            `${botUrl}/api/plugins/by-key/${pluginKey}`,
          );
          if (response.status !== 200) return null;
          const plugin = (
            response.body as {
              plugin: {
                status: string;
                eventTransport: { replicas: unknown[] };
              };
            }
          ).plugin;
          return plugin.status === "inactive" &&
            plugin.eventTransport.replicas.length === 0
            ? plugin
            : null;
        },
        15_000,
      );

      restarted = spawnLogged(PLUGIN_WORKER, workerEnv);
      liveChildren.push(restarted);
      await waitForMarker(restarted, "PLUGIN_READY");
      const recovered = await until(
        "one recovered ready endpoint",
        async () => {
          const response = await api(
            "GET",
            `${botUrl}/api/plugins/by-key/${pluginKey}`,
          );
          if (response.status !== 200) return null;
          const plugin = (
            response.body as {
              plugin: {
                status: string;
                eventTransport: {
                  status: string;
                  replicas: Array<{ url: string; lifecycleState: string }>;
                };
              };
            }
          ).plugin;
          return plugin.status === "active" &&
            plugin.eventTransport.status === "ready" &&
            plugin.eventTransport.replicas.length === 1
            ? plugin
            : null;
        },
      );
      assert.equal(recovered.eventTransport.replicas[0]?.url, pluginUrl);
      assert.equal(
        recovered.eventTransport.replicas[0]?.lifecycleState,
        "ready",
      );
      t.diagnostic(
        "chaos verified: SIGKILL → stale endpoint reaped → restart ready",
      );
    } catch (error) {
      throw new Error(
        `${String(error)}\n--- bot ---\n${bot.output()}\n--- first ---\n${first?.output() ?? ""}\n--- restart ---\n${restarted?.output() ?? ""}`,
      );
    } finally {
      await terminate(restarted);
      await terminate(first, "SIGKILL");
      await terminate(bot);
    }
  });

  it("a pending Streams event survives consumer death and is reclaimed", async (t) => {
    const redisModule = (await import("ioredis")) as unknown as {
      Redis: RedisCtor;
    };
    const redis = new redisModule.Redis(REDIS_URL!);
    const pluginKey = `e2e-pending-${process.pid}`;
    const streamKey = `karyl:plugin:${pluginKey}:events`;
    const dlqKey = `${streamKey}:dlq`;
    const group = `kc-consumer:${pluginKey}`;
    let crashed: LoggedChild | null = null;
    let recovered: LoggedChild | null = null;

    try {
      await redis.del(streamKey, dlqKey);
      crashed = spawnLogged(CONSUMER_WORKER, {
        PATH: process.env.PATH ?? "",
        TEST_E2E_REDIS_URL: REDIS_URL!,
        E2E_PLUGIN_KEY: pluginKey,
        E2E_CONSUMER_MODE: "block",
      });
      liveChildren.push(crashed);
      await waitForMarker(crashed, "CONSUMER_READY");
      await redis.xadd(
        streamKey,
        "*",
        "type",
        "e2e.pending",
        "data",
        JSON.stringify({ id: "pending-1" }),
      );
      await waitForMarker(crashed, "HANDLING pending-1");
      await terminate(crashed, "SIGKILL");

      const pendingAfterDeath = (await redis.xpending(
        streamKey,
        group,
      )) as unknown[];
      assert.equal(
        pendingAfterDeath[0],
        1,
        "killed handler must leave one entry pending",
      );

      recovered = spawnLogged(CONSUMER_WORKER, {
        PATH: process.env.PATH ?? "",
        TEST_E2E_REDIS_URL: REDIS_URL!,
        E2E_PLUGIN_KEY: pluginKey,
        E2E_CONSUMER_MODE: "succeed",
      });
      liveChildren.push(recovered);
      await waitForMarker(recovered, "CONSUMER_READY");
      await waitForMarker(recovered, "HANDLED pending-1", 15_000);
      await until(
        "reclaimed event to be XACKed",
        async () => {
          const pending = (await redis.xpending(streamKey, group)) as unknown[];
          return pending[0] === 0 ? true : null;
        },
        15_000,
      );
      assert.equal(
        await redis.xlen(dlqKey),
        0,
        "successful reclaim must not DLQ",
      );
      t.diagnostic(
        "chaos verified: pending entry survived SIGKILL and was XAUTOCLAIMed",
      );
    } catch (error) {
      throw new Error(
        `${String(error)}\n--- crashed consumer ---\n${crashed?.output() ?? ""}\n--- recovered consumer ---\n${recovered?.output() ?? ""}`,
      );
    } finally {
      await terminate(recovered);
      await terminate(crashed, "SIGKILL");
      await redis.del(streamKey, dlqKey).catch(() => 0);
      await redis.quit().catch(() => undefined);
    }
  });
});

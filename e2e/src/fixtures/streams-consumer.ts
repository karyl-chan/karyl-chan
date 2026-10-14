/** Child process used to leave a real Redis Stream entry pending mid-handler. */

import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

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

interface RedisCtor {
  new (url: string): unknown;
}

const repo = findRepoRoot(path.dirname(fileURLToPath(import.meta.url)));
const consumerPath = path.join(
  repo,
  "packages",
  "plugin-sdk",
  "dist-test",
  "src",
  "streams-consumer.js",
);
const consumerModule = await import(pathToFileURL(consumerPath).href);
const redisModule = (await import("ioredis")) as unknown as { Redis: RedisCtor };
const redis = new redisModule.Redis(required("TEST_E2E_REDIS_URL"));
const pluginKey = required("E2E_PLUGIN_KEY");
const mode = required("E2E_CONSUMER_MODE");
let releaseBlockedHandler: (() => void) | null = null;

const consumer = new consumerModule.StreamsConsumer({
  redis,
  pluginKey,
  blockMs: 100,
  claimMinIdleMs: 200,
  sweepIntervalMs: 100,
  dispatchEvent: async (_eventType: string, data: unknown) => {
    const id = (data as { id?: unknown }).id;
    if (mode === "block") {
      process.stdout.write(`HANDLING ${String(id)}\n`);
      await new Promise<void>((resolve) => {
        releaseBlockedHandler = resolve;
      });
      return;
    }
    process.stdout.write(`HANDLED ${String(id)}\n`);
  },
  log: {
    info() {},
    warn(message: string, meta?: Record<string, unknown>) {
      process.stderr.write(`WARN ${message} ${JSON.stringify(meta ?? {})}\n`);
    },
    error(message: string, meta?: Record<string, unknown>) {
      process.stderr.write(`ERROR ${message} ${JSON.stringify(meta ?? {})}\n`);
    },
  },
});

await consumer.ensureGroups();
consumer.start();
process.stdout.write("CONSUMER_READY\n");

let stopping = false;
async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  releaseBlockedHandler?.();
  await consumer.stop().catch(() => undefined);
  const live = redis as { quit(): Promise<string> };
  await live.quit().catch(() => undefined);
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());

/** Child process used by the abrupt-death E2E. */

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

const repo = findRepoRoot(path.dirname(fileURLToPath(import.meta.url)));
const sdkPath = path.join(repo, "packages", "plugin-sdk", "dist", "index.js");
const sdk = await import(pathToFileURL(sdkPath).href);
const pluginKey = required("E2E_PLUGIN_KEY");
const port = Number(required("E2E_PLUGIN_PORT"));
const botUrl = required("E2E_BOT_URL");
const pluginUrl = required("E2E_PLUGIN_URL");
const setupSecret = required("E2E_SETUP_SECRET");

const plugin = sdk.definePlugin({
  key: pluginKey,
  name: "E2E restartable plugin",
  version: "0.0.1",
  description: "Abrupt-death recovery probe",
});
const started = await plugin.start({
  port,
  host: "127.0.0.1",
  botUrl,
  pluginUrl,
  setupSecret,
});

try {
  await started.whenReady();
  process.stdout.write("PLUGIN_READY\n");
} catch (error) {
  process.stderr.write(`PLUGIN_FAILED ${String(error)}\n`);
  process.exitCode = 1;
  await started.stop().catch(() => undefined);
}

let stopping = false;
async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  await started.stop().catch(() => undefined);
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());

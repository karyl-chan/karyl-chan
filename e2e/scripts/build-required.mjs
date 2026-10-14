import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repo = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const pnpmScript = process.env.npm_execpath;

function runPnpm(args) {
  const command = pnpmScript
    ? process.execPath
    : process.platform === "win32"
      ? "pnpm.cmd"
      : "pnpm";
  const commandArgs = pnpmScript ? [pnpmScript, ...args] : args;
  const result = spawnSync(command, commandArgs, {
    cwd: repo,
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `pnpm ${args.join(" ")} exited ${result.status ?? "without a status"}`,
    );
  }
}

function cleanBuildOutputs() {
  for (const relative of [
    "packages/plugin-wire/dist",
    "packages/plugin-sdk/dist",
    "packages/plugin-sdk/dist-test",
    "packages/voice/dist",
    "packages/bot/build",
    "e2e/dist",
  ]) {
    rmSync(path.join(repo, relative), { recursive: true, force: true });
  }
}

/**
 * rollup-plugin-dts follows the SDK's source alias into plugin-wire. With
 * TypeScript 6 it can leave JS/declaration sidecars beside those imported TS
 * files. They are build by-products, never source; remove only sidecars whose
 * same-basename .ts source exists.
 */
function cleanWireSourceSidecars() {
  const sourceDir = path.join(repo, "packages", "plugin-wire", "src");
  for (const entry of readdirSync(sourceDir)) {
    if (!entry.endsWith(".ts") || entry.endsWith(".d.ts")) continue;
    const stem = entry.slice(0, -3);
    for (const extension of [".js", ".d.ts"]) {
      const sidecar = path.join(sourceDir, `${stem}${extension}`);
      if (existsSync(sidecar)) rmSync(sidecar);
    }
  }
}

cleanBuildOutputs();
try {
  runPnpm(["exec", "tsc", "-p", "packages/plugin-wire/tsconfig.json"]);
  runPnpm(["--dir", "packages/plugin-sdk", "exec", "tsup"]);
  runPnpm([
    "--dir",
    "packages/plugin-sdk",
    "exec",
    "tsc",
    "-p",
    "tsconfig.test.json",
  ]);
  runPnpm(["--dir", "packages/voice", "exec", "tsc", "-p", "tsconfig.json"]);
  runPnpm(["--dir", "packages/bot", "exec", "tsc", "-p", "tsconfig.json"]);
  runPnpm(["--dir", "e2e", "exec", "tsc", "-p", "tsconfig.json"]);
} finally {
  cleanWireSourceSidecars();
}

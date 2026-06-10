#!/usr/bin/env node
// create-karyl-plugin — scaffold a minimal karyl-chan plugin.
//
// Usage:
//   pnpm create karyl-plugin <target-dir> [--key <key>] [--name "<name>"]
//   node packages/create-karyl-plugin/index.js my-plugin
//
// Copies template/ into <target-dir>, substituting the plugin key / name /
// SDK version. Zero runtime dependencies (Node built-ins only) so it runs
// straight from a checkout or as a published `npm create` initializer.

import { mkdir, readdir, readFile, writeFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";

// Bump on each plugin-sdk release so freshly-scaffolded plugins pin a
// compatible SDK. The SDK is pre-release; a caret range tracks patch +
// minor until it reaches 1.0 and the compat policy formalises (PM-6).
export const SDK_VERSION = "^0.9.0";

const HERE = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_DIR = join(HERE, "template");

/** Lowercase, hyphenate, strip to the manifest key charset [a-z0-9-]. */
export function toPluginKey(raw) {
  const key = String(raw)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!/^[a-z0-9][a-z0-9-]*$/.test(key)) {
    throw new Error(
      `cannot derive a valid plugin key from "${raw}" — pass --key <key> ([a-z0-9][a-z0-9-]*)`,
    );
  }
  return key;
}

/** "my-cool-plugin" -> "My Cool Plugin". */
export function toDisplayName(key) {
  return key
    .split("-")
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");
}

// npm strips `.gitignore` (renamed to .npmignore) and `.npmrc` from
// published tarballs, so the template stores them underscore-prefixed and
// we restore the dot on copy.
const RENAME_ON_COPY = {
  _gitignore: ".gitignore",
  _npmrc: ".npmrc",
};

function applyPlaceholders(text, vars) {
  return text
    .replaceAll("__PLUGIN_KEY__", vars.key)
    .replaceAll("__PLUGIN_NAME__", vars.name)
    .replaceAll("__SDK_VERSION__", vars.sdkVersion);
}

/**
 * Recursively copy `src` → `dest`, substituting placeholders in every
 * file's contents. Directories are created as needed.
 */
async function copyTemplate(src, dest, vars) {
  await mkdir(dest, { recursive: true });
  for (const entry of await readdir(src, { withFileTypes: true })) {
    const from = join(src, entry.name);
    const to = join(dest, RENAME_ON_COPY[entry.name] ?? entry.name);
    if (entry.isDirectory()) {
      await copyTemplate(from, to, vars);
    } else {
      const contents = await readFile(from, "utf8");
      await writeFile(to, applyPlaceholders(contents, vars), "utf8");
    }
  }
}

/**
 * Scaffold a plugin into `targetDir`. Exported (separate from the CLI
 * wrapper) so tests can drive it against a temp dir.
 */
export async function scaffold({ targetDir, key, name, sdkVersion = SDK_VERSION }) {
  const resolvedKey = key ?? toPluginKey(basename(targetDir));
  const resolvedName = name ?? toDisplayName(resolvedKey);
  // Refuse to scribble over an existing non-empty directory.
  if (existsSync(targetDir)) {
    const s = await stat(targetDir);
    if (s.isDirectory() && (await readdir(targetDir)).length > 0) {
      throw new Error(`target directory is not empty: ${targetDir}`);
    }
  }
  await copyTemplate(TEMPLATE_DIR, targetDir, {
    key: resolvedKey,
    name: resolvedName,
    sdkVersion,
  });
  return { targetDir, key: resolvedKey, name: resolvedName, sdkVersion };
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--key") args.key = argv[++i];
    else if (a === "--name") args.name = argv[++i];
    else if (a.startsWith("--")) throw new Error(`unknown flag: ${a}`);
    else args._.push(a);
  }
  return args;
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`create-karyl-plugin: ${err.message}`);
    process.exit(2);
  }
  const target = args._[0];
  if (!target) {
    console.error(
      "Usage: create-karyl-plugin <target-dir> [--key <key>] [--name \"<name>\"]",
    );
    process.exit(2);
  }
  const targetDir = resolve(process.cwd(), target);
  try {
    const out = await scaffold({
      targetDir,
      key: args.key,
      name: args.name,
    });
    const rel = basename(out.targetDir);
    console.log(`\n✓ Scaffolded "${out.name}" (${out.key}) in ${rel}/\n`);
    console.log("Next steps:");
    console.log(`  cd ${rel}`);
    console.log("  npm install");
    console.log("  cp .env.example .env   # fill in BOT_URL + setup secret");
    console.log("  npm run dev\n");
    console.log(
      "Register the setup secret in the bot admin UI (Plugins → Security)",
    );
    console.log("before the plugin can register. See the generated README.\n");
  } catch (err) {
    console.error(`create-karyl-plugin: ${err.message}`);
    process.exit(1);
  }
}

// Only run the CLI when invoked directly, not when imported by tests.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}

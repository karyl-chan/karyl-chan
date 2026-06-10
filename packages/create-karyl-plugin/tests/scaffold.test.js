import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  scaffold,
  toPluginKey,
  toDisplayName,
  SDK_VERSION,
} from "../index.js";

async function freshTmp() {
  return mkdtemp(join(tmpdir(), "ckp-"));
}

test("toPluginKey normalises to the manifest charset", () => {
  assert.equal(toPluginKey("My Cool Plugin"), "my-cool-plugin");
  assert.equal(toPluginKey("  Foo__Bar  "), "foo-bar");
  assert.throws(() => toPluginKey("!!!"), /valid plugin key/);
});

test("toDisplayName title-cases the key", () => {
  assert.equal(toDisplayName("my-cool-plugin"), "My Cool Plugin");
});

test("scaffold derives key/name from the target dir and fills placeholders", async () => {
  const base = await freshTmp();
  const targetDir = join(base, "my-plugin");
  const out = await scaffold({ targetDir });

  assert.equal(out.key, "my-plugin");
  assert.equal(out.name, "My Plugin");
  assert.equal(out.sdkVersion, SDK_VERSION);

  // package.json: valid JSON, name == key, SDK version pinned, no leftovers.
  const pkgRaw = await readFile(join(targetDir, "package.json"), "utf8");
  const pkg = JSON.parse(pkgRaw);
  assert.equal(pkg.name, "my-plugin");
  assert.equal(pkg.dependencies["@karyl-chan/plugin-sdk"], SDK_VERSION);
  assert.ok(!pkgRaw.includes("__PLUGIN_"));

  // Dotfiles restored from their underscore-prefixed template names.
  const names = await readdir(targetDir);
  assert.ok(names.includes(".gitignore"));
  assert.ok(names.includes(".npmrc"));
  assert.ok(!names.includes("_gitignore"));

  // Source carries the substituted command name; no placeholders survive.
  const pluginTs = await readFile(join(targetDir, "src/plugin.ts"), "utf8");
  assert.ok(pluginTs.includes('name: "my-plugin-ping"'));
  assert.ok(!pluginTs.includes("__PLUGIN_KEY__"));
});

test("explicit --key / --name override the derivation", async () => {
  const base = await freshTmp();
  const targetDir = join(base, "whatever");
  const out = await scaffold({ targetDir, key: "radio", name: "Karyl Radio" });
  assert.equal(out.key, "radio");
  assert.equal(out.name, "Karyl Radio");
  const pkg = JSON.parse(await readFile(join(targetDir, "package.json"), "utf8"));
  assert.equal(pkg.name, "radio");
});

test("refuses to scaffold into a non-empty directory", async () => {
  const base = await freshTmp();
  const targetDir = join(base, "occupied");
  await mkdir(targetDir, { recursive: true });
  await writeFile(join(targetDir, "keep.txt"), "x");
  await assert.rejects(() => scaffold({ targetDir }), /not empty/);
});

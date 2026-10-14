import { test } from "node:test";
import assert from "node:assert/strict";
import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  scaffold,
  toPluginKey,
  toDisplayName,
  SDK_VERSION,
} from "../index.js";

async function freshTmp() {
  return mkdtemp(join(tmpdir(), "ckp-"));
}

const sdkPackagePath = fileURLToPath(
  new URL("../../plugin-sdk/package.json", import.meta.url),
);
const repoRootUrl = new URL("../../../", import.meta.url);

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

  // npm can install every generated dependency from the public registry;
  // no project-level registry override or token configuration is emitted.
  const names = await readdir(targetDir);
  assert.ok(names.includes(".gitignore"));
  assert.ok(!names.includes(".npmrc"));
  assert.ok(!names.includes("_gitignore"));

  // Source carries the substituted command name; no placeholders survive.
  const pluginTs = await readFile(join(targetDir, "src/plugin.ts"), "utf8");
  assert.ok(pluginTs.includes('name: "my-plugin-ping"'));
  assert.ok(!pluginTs.includes("__PLUGIN_KEY__"));
});

test("generated SDK range stays in lockstep with the workspace SDK release", async () => {
  const sdkPackage = JSON.parse(await readFile(sdkPackagePath, "utf8"));
  const initializerPackage = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  assert.equal(initializerPackage.version, sdkPackage.version);
  assert.equal(
    SDK_VERSION,
    `^${sdkPackage.version}`,
    "bump SDK_VERSION and release create-karyl-plugin with every SDK release",
  );
});

test("published package metadata exposes the public initializer", async () => {
  const packagePath = fileURLToPath(new URL("../package.json", import.meta.url));
  const pkg = JSON.parse(await readFile(packagePath, "utf8"));
  assert.equal(pkg.name, "create-karyl-plugin");
  assert.equal(pkg.bin["create-karyl-plugin"], "index.js");
  assert.equal(pkg.publishConfig.access, "public");
  assert.equal(pkg.repository.directory, "packages/create-karyl-plugin");
  assert.ok(pkg.files.includes("CHANGELOG.md"));
});

test("template teaches the supported RPC and readiness interfaces", async () => {
  const base = await freshTmp();
  const targetDir = join(base, "supported-interface");
  await scaffold({ targetDir });

  const pluginSource = await readFile(join(targetDir, "src/plugin.ts"), "utf8");
  assert.match(pluginSource, /ctx\.discord\./);

  const readme = await readFile(join(targetDir, "README.md"), "utf8");
  assert.match(readme, /ctx\.discord\./);
  assert.match(readme, /ctx\.botRpc/);
  assert.doesNotMatch(readme, /GitHub Packages|read:packages/);

  const compose = await readFile(join(targetDir, "docker-compose.yml"), "utf8");
  assert.match(compose, /127\.0\.0\.1:3000\/health\/ready/);
});

test("release and CI automation continuously cover the initializer", async () => {
  const initializerPackage = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  const releaseConfig = JSON.parse(
    await readFile(new URL("release-please-config.json", repoRootUrl), "utf8"),
  );
  assert.deepEqual(
    releaseConfig.plugins.find((plugin) => plugin.type === "linked-versions"),
    {
      type: "linked-versions",
      groupName: "plugin-platform",
      components: ["plugin-sdk", "create-karyl-plugin"],
    },
  );
  assert.deepEqual(
    releaseConfig.packages["packages/create-karyl-plugin"],
    {
      component: "create-karyl-plugin",
      "package-name": "create-karyl-plugin",
      "extra-files": [{ type: "generic", path: "index.js" }],
    },
  );

  const releaseManifest = JSON.parse(
    await readFile(new URL(".release-please-manifest.json", repoRootUrl), "utf8"),
  );
  assert.equal(
    releaseManifest["packages/create-karyl-plugin"],
    initializerPackage.version,
  );

  const ci = await readFile(
    new URL(".github/workflows/ci.yml", repoRootUrl),
    "utf8",
  );
  assert.match(ci, /name: create-karyl-plugin-golden-path/);
  assert.match(ci, /test:packed/);

  const releaseWorkflow = await readFile(
    new URL(".github/workflows/release-please.yml", repoRootUrl),
    "utf8",
  );
  assert.match(releaseWorkflow, /packages\/create-karyl-plugin--release_created/);
  assert.match(releaseWorkflow, /publish-create-karyl-plugin\.yml/);

  const publishWorkflow = await readFile(
    new URL(
      ".github/workflows/publish-create-karyl-plugin.yml",
      repoRootUrl,
    ),
    "utf8",
  );
  assert.match(publishWorkflow, /create-karyl-plugin-v\*/);
  assert.match(publishWorkflow, /id-token: write/);
  assert.match(publishWorkflow, /--provenance/);
  assert.match(publishWorkflow, /npm view "@karyl-chan\/plugin-sdk@\$\{sdk_version\}"/);

  await access(new URL("../CHANGELOG.md", import.meta.url));
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

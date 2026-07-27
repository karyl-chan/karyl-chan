/**
 * ADR guard: `src/web` must never import `@karyl-chan/plugin-wire`.
 *
 * The SDK's `.` entry is bundled by tsup and vendors plugin-wire into
 * `dist` (inlined runtime values + types). But the `./web` and
 * `./web/vue` exports ship RAW `src` TypeScript — they are not bundled,
 * so any `@karyl-chan/plugin-wire` import in `src/web` would reach a
 * consumer as a bare specifier for a package that was never published to
 * npm, and fail to resolve. See
 * docs/adr/0001-plugin-wire-private-vendored-into-sdk.md.
 *
 * This is a static source scan (not a type check) so it catches the
 * violation regardless of how the import is written.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// This file compiles to dist-test/tests/, so the real source tree is two
// levels up (dist-test/tests → dist-test → package root) then src/web.
const here = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = join(here, "..", "..", "src", "web");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (full.endsWith(".ts")) out.push(full);
  }
  return out;
}

test("src/web never imports @karyl-chan/plugin-wire", () => {
  const offenders: string[] = [];
  for (const file of walk(WEB_DIR)) {
    const src = readFileSync(file, "utf8");
    if (/@karyl-chan\/plugin-wire/.test(src)) {
      offenders.push(file.slice(WEB_DIR.length + 1));
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `src/web ships raw (unbundled) TS and must not import the ` +
      `never-published plugin-wire package. Offending files: ${offenders.join(", ")}`,
  );
});

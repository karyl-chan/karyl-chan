/**
 * The built `@karyl-chan/plugin-sdk/behavior-receiver` entry stands alone:
 *
 *   - it loads nothing but Node built-ins — not fastify, not the SDK's
 *     main entry, not the never-published plugin-wire (whose fixtures it
 *     vendors, docs/adr/0001-plugin-wire-private-vendored-into-sdk.md);
 *   - its `.d.ts` names no plugin-wire either, so a consumer's type check
 *     resolves;
 *   - the export map resolves it by its public name.
 *
 * Reads `dist/`, so run it after `pnpm build` (the `test` script's order in CI).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isBuiltin } from "node:module";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// dist-test/tests → package root
const here = dirname(fileURLToPath(import.meta.url));
const DIST = join(here, "..", "..", "dist");

/** Every module specifier a file imports or re-exports. */
function specifiers(source: string): string[] {
  const found = new Set<string>();
  for (const m of source.matchAll(
    /\b(?:from|import)\s*\(?\s*["']([^"']+)["']/g,
  ))
    found.add(m[1]!);
  return [...found].sort();
}

test("the bundle loads only Node built-ins", () => {
  const js = readFileSync(join(DIST, "behavior-receiver.js"), "utf8");
  // tsup drops the `node:` prefix, so `crypto` counts too
  const foreign = specifiers(js).filter((s) => !isBuiltin(s));
  assert.deepEqual(
    foreign,
    [],
    `dist/behavior-receiver.js imports ${foreign.join(", ")}`,
  );
  assert.doesNotMatch(js, /fastify/i);
});

test("the declarations name no workspace-private package", () => {
  const dts = readFileSync(join(DIST, "behavior-receiver.d.ts"), "utf8");
  const foreign = specifiers(dts).filter((s) => !isBuiltin(s));
  assert.deepEqual(
    foreign,
    [],
    `dist/behavior-receiver.d.ts imports ${foreign.join(", ")}`,
  );
});

test("the export map resolves the subpath to the bundle", async () => {
  // a self-reference by package name goes through package.json `exports`
  const specifier = "@karyl-chan/plugin-sdk/behavior-receiver";
  const mod = (await import(specifier)) as Record<string, unknown>;
  assert.deepEqual(Object.keys(mod).sort(), [
    "BEHAVIOR_WEBHOOK_FIXTURES",
    "createNonceStore",
    "createReceiver",
    "signResponse",
    "verifyRequest",
  ]);
});

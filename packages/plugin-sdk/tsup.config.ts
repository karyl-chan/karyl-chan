import { defineConfig } from "tsup";

/**
 * The SDK's `.` entry is bundled (not plain `tsc`) so the
 * workspace-private `@karyl-chan/plugin-wire` package can be vendored
 * into `dist` — inlined as both runtime values and `.d.ts` types — so
 * published consumers get the whole Wire Contract in one install with no
 * second package to depend on. See
 * `docs/adr/0001-plugin-wire-private-vendored-into-sdk.md`.
 *
 * Mechanism: tsconfig.json aliases `@karyl-chan/plugin-wire` to its
 * `src/index.ts`, so both the esbuild JS bundle and the rollup-dts
 * `.d.ts` bundle treat the wire contract as internal source and inline
 * it fully — runtime values AND type declarations. (A bare
 * package/dist re-export leaves a dangling `from "@karyl-chan/plugin-wire"`
 * in the emitted `.d.ts`, which the aliased-source route avoids.)
 * `noExternal` below is a belt-and-suspenders fallback for the JS.
 *
 * Everything else the SDK imports (`fastify` dependency,
 * `discord-api-types` peerDependency, Node built-ins) stays external —
 * tsup externalizes `dependencies` + `peerDependencies` by default.
 *
 * Two entries are built here, each a complete bundle: `.` and
 * `./behavior-receiver`. The latter vendors only the behavior webhook
 * fixtures and must load nothing but Node built-ins — no fastify, no main
 * entry, no shared chunk (guarded by
 * tests/behavior-receiver-bundle.contract.test.ts). They are two builds,
 * not two entries of one: `splitting: false` keeps the JS whole, but the
 * `.d.ts` bundler would still split the types both entries use (the main
 * entry's behavior action payload is built on the receiver's webhook
 * types, #127) into a shared chunk. Separate builds inline them in each.
 * Neither cleans `dist` (they run in parallel); the build script does.
 * The `./web` and `./web/vue` exports ship raw `src` TS (see package.json
 * `exports`) and are intentionally NOT bundled — which is why `src/web`
 * must never import `plugin-wire` (guarded by
 * tests/web-no-plugin-wire.contract.test.ts).
 */
const common = {
  format: ["esm" as const],
  target: "es2022",
  outDir: "dist",
  dts: true,
  clean: false,
  sourcemap: false,
  splitting: false,
  // Vendor the wire contract in; belt-and-suspenders since it is already
  // a devDependency (tsup bundles non-dependencies by default).
  noExternal: ["@karyl-chan/plugin-wire"],
};

export default defineConfig([
  { ...common, entry: { index: "src/index.ts" } },
  { ...common, entry: { "behavior-receiver": "src/behavior-receiver/index.ts" } },
]);

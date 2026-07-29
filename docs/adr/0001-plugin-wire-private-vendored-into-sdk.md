# plugin-wire is workspace-private and vendored into the SDK's dist

The bot↔SDK wire contract (manifest types, canonical events, scope vocabulary, dispatch payloads, validation, contract fixtures) lives in a `plugin-wire` workspace package that is **not published to npm**. The bot and frontend depend on it via `workspace:*`; the published `@karyl-chan/plugin-sdk` inlines its types and runtime values into `dist` at build time (this is why the SDK build uses a bundler instead of plain `tsc`). We chose this over publishing `@karyl-chan/plugin-wire` because the SDK should ship every `.d.ts` its consumers need in one install, with no second public package to version and maintain.

## Consequences

- The SDK's `./web` and `./web/vue` exports ship raw `src` TS, which bundling cannot cover — `src/web` must never import `plugin-wire` (guarded by a contract test).
- The wire contract has no version number of its own; compat statements are made in SDK-version coordinates (see the Compat Floor and Event Ceiling terms in `packages/plugin-wire/CONTEXT.md`).

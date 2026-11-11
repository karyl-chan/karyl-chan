# plugin-wire is workspace-private and vendored into the SDK's dist

The bot↔SDK wire contract (manifest types, canonical events, scope vocabulary, dispatch payloads, validation, contract fixtures) lives in a `plugin-wire` workspace package that is **not published to npm**. The bot and frontend depend on it via `workspace:*`; the published `@karyl-chan/plugin-sdk` inlines its types and runtime values into `dist` at build time (this is why the SDK build uses a bundler instead of plain `tsc`). We chose this over publishing `@karyl-chan/plugin-wire` because the SDK should ship every `.d.ts` its consumers need in one install, with no second public package to version and maintain.

## Consequences

- The SDK's `./web` and `./web/vue` exports ship raw `src` TS, which bundling cannot cover — `src/web` must never import `plugin-wire` (guarded by a contract test).
- The behavior webhook fixtures (`CONTRACT_FIXTURES.behaviorWebhook`) reach receiver authors through the SDK's `./behavior-receiver` subpath, which vendors them into its own bundle as `BEHAVIOR_WEBHOOK_FIXTURES`. Their shape is therefore SDK public API: changing it is an SDK semver event. release-please assigns commits to components by path and plugin-wire is not one, so such a change ships as an SDK release only through the `feat`/`fix` commit that also touches `packages/plugin-sdk` (its `behavior-receiver` type and fixture tests always need updating with it).
- The wire contract has no version number of its own; compat statements are made in SDK-version coordinates (see the Compat Floor and Event Ceiling terms in `packages/plugin-wire/GLOSSARY.md`).

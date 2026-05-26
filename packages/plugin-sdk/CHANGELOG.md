# Changelog

## [0.5.0](https://github.com/karyl-chan/karyl-chan/compare/plugin-sdk-v0.4.0...plugin-sdk-v0.5.0) (2026-05-26)


### Features

* **plugin-sdk:** `bootstrapPluginSession` accepts `surfaceFromClaims` to derive the surface from the JWT instead of the URL `?surface=` param. Plugins whose link URLs only carry `?token=` (and embed the manage-vs-session distinction in the token's capabilities) can now drop their hand-rolled `decodeJwt` / `exchangeManageJwt` / `loadStored*` plumbing without forcing the bot side to also start emitting `?surface=` query params. URL `?surface=` still wins when present, so existing call sites keep working unchanged.

## [0.4.0](https://github.com/karyl-chan/karyl-chan/compare/plugin-sdk-v0.3.0...plugin-sdk-v0.4.0) (2026-05-26)


### ⚠ BREAKING CHANGES

* **plugin-sdk:** `manifest.sdk_version` is now auto-stamped from the SDK's own package.json — plugins that set it manually no longer need to.
* **plugin-sdk:** SDK now owns the `/events` route and `eventHandlers` is declared via plugin config; the previous hand-rolled `app.post('/events', ...)` route in plugins has been removed.
* **plugin-sdk:** typed RPC facade replaces raw `callBotRpc(...)`; plugins should migrate to `ctx.discord.*` and `ctx.voice.*` for compile-time-checked method names + payload shapes.

### Features

* **plugin-sdk:** auto-retry callBotRpc on 503/429/network ([5d6a4b0](https://github.com/karyl-chan/karyl-chan/commit/5d6a4b0))
* **plugin-sdk:** expose discord/voice on StartedPlugin too ([6532191](https://github.com/karyl-chan/karyl-chan/commit/6532191))
* **plugin-sdk:** export createPluginRpc + RpcCaller / PluginRpc types ([5fcef4f](https://github.com/karyl-chan/karyl-chan/commit/5fcef4f))
* **plugin-sdk:** SDK owns /events route + eventHandlers config ([7d7ed36](https://github.com/karyl-chan/karyl-chan/commit/7d7ed36))
* **plugin-sdk:** stamp sdk_version onto every manifest ([159ac9c](https://github.com/karyl-chan/karyl-chan/commit/159ac9c))
* **plugin-sdk:** typed RPC facade ctx.discord / ctx.voice ([8530d0a](https://github.com/karyl-chan/karyl-chan/commit/8530d0a))


### Documentation

* **plugin-sdk:** document L-1..L-4 lockdown surface ([beff6d4](https://github.com/karyl-chan/karyl-chan/commit/beff6d4))

## [0.3.0](https://github.com/karyl-chan/karyl-chan/compare/plugin-sdk-v0.2.0...plugin-sdk-v0.3.0) (2026-05-26)


### Features

* **bot, sdk, plugin-example:** users.get RPC for guildless user lookup ([e55362d](https://github.com/karyl-chan/karyl-chan/commit/e55362d10fc6d0e6056886e4868ed9d7cfa99404))
* **bot, sdk:** SDK audit cleanup — 8 outdated docs / questionable designs ([92dbef3](https://github.com/karyl-chan/karyl-chan/commit/92dbef3206894bc5ae33489ef7bba1b0004d43e9))
* **bot, sdk:** Workpack B-1 — bot RPC補完 (11 endpoints + voice listenerIds) ([96216e1](https://github.com/karyl-chan/karyl-chan/commit/96216e1e6c572d414aa70b09d35e2b42e54aa849))
* **bot,sdk:** defer reads default_ephemeral; mismatch via DELETE [@original](https://github.com/original) ([58e24cf](https://github.com/karyl-chan/karyl-chan/commit/58e24cfef1cee80513ff41e40b452c46ac17ee2b))
* **plugin-sdk:** add /web subpath with browser-side plugin SPA helpers ([51e2119](https://github.com/karyl-chan/karyl-chan/commit/51e2119c873fda2ee61abbb807e0bff40e4824ee))
* **sdk, bot:** Workpack A — discord-api-types + modal + select + autocomplete ([f805612](https://github.com/karyl-chan/karyl-chan/commit/f805612ca1bffe3ed589cbc32269175d4b56c3f6))
* **sdk, bot:** Workpack D — Web SDK bootstrap + config schema constraints + validator ([dda613f](https://github.com/karyl-chan/karyl-chan/commit/dda613f470199833a96c127f9e108880b92861a4))
* **sdk, plugin-example:** Workpack C — auto-inject me.log/me.metrics scopes + reference demo ([f473314](https://github.com/karyl-chan/karyl-chan/commit/f473314b613a8e78f59d3339b85f3061c175b7f4))
* **sdk:** Workpack C — lifecycle hooks + observability surface ([06d538c](https://github.com/karyl-chan/karyl-chan/commit/06d538cd486c74df507844e8a3b57a4cfadc8475))


### Bug Fixes

* build-verification fixups after UI extraction ([73e48e8](https://github.com/karyl-chan/karyl-chan/commit/73e48e808ca4009abd9a8baf00cc871c33e5e57c))
* **sdk, bot, plugin-example:** Workpack D review findings — timer leak + silent-denied + reserved-params + sentinel bypass ([c6e48f3](https://github.com/karyl-chan/karyl-chan/commit/c6e48f315bce08f57077bd96d143ff40f07a12a5))
* **sdk, bot:** address Workpack A review findings ([fdae6cc](https://github.com/karyl-chan/karyl-chan/commit/fdae6cc6ef68fdeaf750cf283ed962dc9c40e743))
* **sdk, bot:** Workpack A — round 2 review findings ([9c09cc2](https://github.com/karyl-chan/karyl-chan/commit/9c09cc2dccd41c9cb5781689a1e00ec77d65e6c9))
* **sdk, bot:** Workpack C review findings — histogram drain + lifecycle IIFE rejection ([dabc42b](https://github.com/karyl-chan/karyl-chan/commit/dabc42bf9c9896f2a4b7917f9b0fb54f7950484f))
* **sdk, plugin-example:** address Phase 6 review findings ([0d4d3ee](https://github.com/karyl-chan/karyl-chan/commit/0d4d3eecade3775ee09dccf349639db0ce13451a))

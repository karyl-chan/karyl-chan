# Changelog

## [1.1.0](https://github.com/karyl-chan/karyl-chan/compare/bot-v1.0.1...bot-v1.1.0) (2026-05-26)


### Features

* **bot, sdk, plugin-example:** users.get RPC for guildless user lookup ([e55362d](https://github.com/karyl-chan/karyl-chan/commit/e55362d10fc6d0e6056886e4868ed9d7cfa99404))
* **bot, sdk:** Workpack B-1 — bot RPC補完 (11 endpoints + voice listenerIds) ([96216e1](https://github.com/karyl-chan/karyl-chan/commit/96216e1e6c572d414aa70b09d35e2b42e54aa849))
* **bot, ui:** Workpack C — surface plugin health + metrics on admin detail page ([7e46dfe](https://github.com/karyl-chan/karyl-chan/commit/7e46dfe44e3d518925cbe6cbf26367caae2d463e))
* **bot:** admin-login uses embed + link button instead of plain text URL ([a15217e](https://github.com/karyl-chan/karyl-chan/commit/a15217ec138d522173e5e5875e25c5cff603ccf2))
* **bot:** BOT_SKIP_DISCORD env flag for dev-only gateway skip ([f45d726](https://github.com/karyl-chan/karyl-chan/commit/f45d7264197b72527c0f508e4860253463a6cd0f))
* **bot:** protected system behaviors sort before the optional one ([4ea9a75](https://github.com/karyl-chan/karyl-chan/commit/4ea9a752e7702a2629c97bc84f9e8476f6e3e9dc))
* **bot:** system behaviors get the enable toggle (login/break protected) ([f333d28](https://github.com/karyl-chan/karyl-chan/commit/f333d28081f4fc0a5880b546a27d184c842354fe))
* **bot:** Workpack C — plugin lifecycle dispatch + health poller + observability RPC ([7be1b78](https://github.com/karyl-chan/karyl-chan/commit/7be1b782503d018a4c8182ffad256d2106cf30b8))
* **sdk, bot:** Workpack A — discord-api-types + modal + select + autocomplete ([f805612](https://github.com/karyl-chan/karyl-chan/commit/f805612ca1bffe3ed589cbc32269175d4b56c3f6))
* **sdk, bot:** Workpack D — Web SDK bootstrap + config schema constraints + validator ([dda613f](https://github.com/karyl-chan/karyl-chan/commit/dda613f470199833a96c127f9e108880b92861a4))
* **ui:** extract @karyl-chan/ui from bot frontend ([fce60e2](https://github.com/karyl-chan/karyl-chan/commit/fce60e288a331d4002fd53c6e89acaa9afd36f9f))
* **ui:** Workpack D — per-field validation errors + constraint attributes ([ce854ec](https://github.com/karyl-chan/karyl-chan/commit/ce854ecb7c7c4438ad752a25c9fc8a83a561252f))


### Bug Fixes

* **bot, ui:** batch C — config type round-trip + UI plugin switch ([9bd72e0](https://github.com/karyl-chan/karyl-chan/commit/9bd72e0e45c6ea518d2c7f1cf14630103121d6ff))
* **bot/frontend:** valid sidebar icon names + regroup all_bot_dms tab ([894335b](https://github.com/karyl-chan/karyl-chan/commit/894335b4ba971d02f43124e50b15ed73bd0ebd06))
* **bot:** allow system behaviors to trigger via message_pattern ([bf86dda](https://github.com/karyl-chan/karyl-chan/commit/bf86dda6eb7876495cb3734ef1dc667c1a82a243))
* **bot:** batch A — close cross-plugin / cross-guild RPC gaps ([8bb2cad](https://github.com/karyl-chan/karyl-chan/commit/8bb2cadecccb00c53931440996f8a697289ca7e0))
* **bot:** batch B — defer always ephemeral + dispatch IIFE try/catch ([2622155](https://github.com/karyl-chan/karyl-chan/commit/26221554f6f5b6ae1fa0f6a22caf877552a2dafd))
* **bot:** batch D — enabled_guilds defaults, flag passthrough, lifecycle no-op ([c3efe64](https://github.com/karyl-chan/karyl-chan/commit/c3efe64a29d00ac6ed6b2b22d158dbcaeac3ff03))
* **bot:** close continuous-forward session flow gaps ([1926a14](https://github.com/karyl-chan/karyl-chan/commit/1926a148918b48255e2921b825acd3090a336438))
* **bot:** copy @karyl-chan/ui into the frontend-build Docker stage ([015c21f](https://github.com/karyl-chan/karyl-chan/commit/015c21f88994a806b70c8046d6a8f6e4851b1a84))
* **bot:** keep pino-pretty in production deps ([c7e1299](https://github.com/karyl-chan/karyl-chan/commit/c7e1299b8adae5a0b88a7c36bfb292b41fff8f5c))
* **bot:** reconcile Discord commands after behavior CRUD ([2fa250b](https://github.com/karyl-chan/karyl-chan/commit/2fa250be24a6e8193dcfb86522b5258b48f9802d))
* **bot:** Workpack B-1 review findings — cross-guild leak + RL bucket + liveness + reaction encoding ([b08d5b0](https://github.com/karyl-chan/karyl-chan/commit/b08d5b0f0b90e3db54ae4b7883be6bc907708b12))
* **bot:** xhigh review — close 6 confirmed defects ([b58e9f8](https://github.com/karyl-chan/karyl-chan/commit/b58e9f86bc17ab9ec2e37926a9b6ebc56c28eebc))
* build-verification fixups after UI extraction ([73e48e8](https://github.com/karyl-chan/karyl-chan/commit/73e48e808ca4009abd9a8baf00cc871c33e5e57c))
* **sdk, bot, plugin-example:** Workpack D review findings — timer leak + silent-denied + reserved-params + sentinel bypass ([c6e48f3](https://github.com/karyl-chan/karyl-chan/commit/c6e48f315bce08f57077bd96d143ff40f07a12a5))
* **sdk, bot:** address Workpack A review findings ([fdae6cc](https://github.com/karyl-chan/karyl-chan/commit/fdae6cc6ef68fdeaf750cf283ed962dc9c40e743))
* **sdk, bot:** Workpack A — round 2 review findings ([9c09cc2](https://github.com/karyl-chan/karyl-chan/commit/9c09cc2dccd41c9cb5781689a1e00ec77d65e6c9))
* **sdk, bot:** Workpack C review findings — histogram drain + lifecycle IIFE rejection ([dabc42b](https://github.com/karyl-chan/karyl-chan/commit/dabc42bf9c9896f2a4b7917f9b0fb54f7950484f))
* **sdk, plugin-example:** address Phase 6 review findings ([0d4d3ee](https://github.com/karyl-chan/karyl-chan/commit/0d4d3eecade3775ee09dccf349639db0ce13451a))

## [1.0.1](https://github.com/karyl-chan/karyl-chan/compare/bot-v1.0.0...bot-v1.0.1) (2026-05-23)


### Bug Fixes

* improve layout for AllServersDashboard and ensure proper scrolling behavior ([438f945](https://github.com/karyl-chan/karyl-chan/commit/438f945f91bebc98e0fe74a8c51bc9528252a648))

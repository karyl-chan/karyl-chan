# Changelog

## [1.9.0](https://github.com/karyl-chan/karyl-chan/compare/bot-v1.8.0...bot-v1.9.0) (2026-06-12)


### Features

* **bot,sdk:** guild-feature event reach enforcement + 3-tier RPC gate (PM-8) ([aa5ef2a](https://github.com/karyl-chan/karyl-chan/commit/aa5ef2a0d737dd956317531ba0b4304bac88db9c))
* **bot:** dev-only DM inject seam for the inbox SSE pipeline ([701b0f5](https://github.com/karyl-chan/karyl-chan/commit/701b0f53ef7c18d7bc5339e34dead09e91b66b85))
* **bot:** per-guild feature config editing + fallback-tier visibility (PD-1.3) ([6e1f4b4](https://github.com/karyl-chan/karyl-chan/commit/6e1f4b40f674346e3d8fb7493f4e1d5a7d69dafb))
* **events:** ephemeral self-messages become an opt-in event with visibility ([7486aa3](https://github.com/karyl-chan/karyl-chan/commit/7486aa3a9f1dc5c225a88cd929490062a6a43a67))
* **frontend:** global event subscription grants in the Security tab (PM-8) ([76c4348](https://github.com/karyl-chan/karyl-chan/commit/76c4348b08e11ae7e261385c702a319499a8c6c7))
* **frontend:** plugin install guidance + journey-state surfacing (PD-1.2) ([90f807e](https://github.com/karyl-chan/karyl-chan/commit/90f807ee1522ca0177a42fef67f6db6024ba9023))


### Bug Fixes

* **bot:** explicit types on resolver fallback locals (docker tsc strictness) ([7cd6ece](https://github.com/karyl-chan/karyl-chan/commit/7cd6ecef7b0e60add19273cb9e39553959ee8610))
* **events:** don't fan out ephemeral self-messages to plugins ([f844f8a](https://github.com/karyl-chan/karyl-chan/commit/f844f8a4ced15cb04078be8f39c8380ea3dfa79e))

## [1.8.0](https://github.com/karyl-chan/karyl-chan/compare/bot-v1.7.0...bot-v1.8.0) (2026-06-12)


### Features

* **bot:** include channel_name/guild_name in message events ([2e8425d](https://github.com/karyl-chan/karyl-chan/commit/2e8425d0cb21b3aa220bbb8dbb4323885f2e5933))
* **events:** self-message, edit and delete fan-out for plugins ([fce4e39](https://github.com/karyl-chan/karyl-chan/commit/fce4e39b1b68106ddc93010c6fb318898cafd901))

## [1.7.0](https://github.com/karyl-chan/karyl-chan/compare/bot-v1.6.0...bot-v1.7.0) (2026-06-11)


### ⚠ BREAKING CHANGES

* **ui:** AppModal now pads its body by default; slot content with its own outer padding will double-pad. Either remove the caller's wrapper padding or pass padding="0".

### Features

* **bot,frontend:** signed dispatch probe after register + manual test button (PM-7.9.4) ([23f6cf6](https://github.com/karyl-chan/karyl-chan/commit/23f6cf64d210749a3d82f3286aa71c0c5ecfee5a))
* **bot:** per-plugin dispatch-path health tracking (PM-7.9.1) ([989e0b3](https://github.com/karyl-chan/karyl-chan/commit/989e0b35701bec9c37a146ec3333c101a4b4eecc))
* **bot:** SDK wire-format compat verdict at register + admin API (PM-7.9.3) ([923758b](https://github.com/karyl-chan/karyl-chan/commit/923758ba1c58305fa6f590223f4cbedc0881a02b))
* **frontend:** split liveness vs dispatch health on PluginCard (PM-7.9.2) ([a79da6b](https://github.com/karyl-chan/karyl-chan/commit/a79da6b20bcac598edcac5481e4bd4df71fdb60b))
* **ui:** AppModal pads body by default via padding prop ([c6c0cdc](https://github.com/karyl-chan/karyl-chan/commit/c6c0cdc1d4a6eced05904f6858fbdf477697193f))


### Bug Fixes

* **bot,frontend:** review small fixes — floor coupling, probe single-flight, card truthfulness ([79788c3](https://github.com/karyl-chan/karyl-chan/commit/79788c3ba66e277a046172390c202bdf320ef2d6))
* **bot,sdk:** dispatch-health streak semantics — probe isolation, breaker noise, 400 trust ([019a03f](https://github.com/karyl-chan/karyl-chan/commit/019a03f05d4d642c992edee3d84773769d0e1cff))
* **bot,sdk:** reply_to ping opt-out holes — snake_case, explicit allowlists, SDK types ([3f43a7e](https://github.com/karyl-chan/karyl-chan/commit/3f43a7eb1b4c9c9b769e4eb0cf92bc52dfcc96d1))
* **bot:** close the dispatch-health blind spots — pre-flight failures + lifecycle path ([c95640d](https://github.com/karyl-chan/karyl-chan/commit/c95640ddabdadb04452c6257c9c327e05319dd57))
* **bot:** reply_to replies ping their author by default ([266ee9c](https://github.com/karyl-chan/karyl-chan/commit/266ee9c535ce9e502c9e8792b9f87a348a1114d1))

## [1.6.0](https://github.com/karyl-chan/karyl-chan/compare/bot-v1.5.0...bot-v1.6.0) (2026-06-10)


### Features

* **auth:** route session tokens through getSessionStore() for cross-shard SSO ([3599327](https://github.com/karyl-chan/karyl-chan/commit/3599327362a162841dc91b70a21a87a8fb125386))
* **behavior:** carry _meta on the pattern/session webhook payload ([e9f7e0d](https://github.com/karyl-chan/karyl-chan/commit/e9f7e0d888da76f264239ab965c0d2cfd86ee81a))
* **behavior:** enforce audience + placement on the slash dispatch path ([3972c95](https://github.com/karyl-chan/karyl-chan/commit/3972c95f79ab780215ad585ba046161c4016c0d7))
* **behavior:** enforce behavior:&lt;scopeKey&gt;.manage scoped delegation ([518aa00](https://github.com/karyl-chan/karyl-chan/commit/518aa009b03c1ed93e8b8b46ec385dd58d85894d))
* **behavior:** give audience groups a write path and management UI ([2678f2f](https://github.com/karyl-chan/karyl-chan/commit/2678f2f51fd85203955d9290ddecf2a24e0b24f5))
* **behavior:** guild-channel message patterns ([652adb8](https://github.com/karyl-chan/karyl-chan/commit/652adb87be6eb3bd2e388a44fa976c1ad98b75ed))
* **behavior:** hide + reject integrationTypes for message_pattern behaviors ([610ee7e](https://github.com/karyl-chan/karyl-chan/commit/610ee7e1aaf5771fbabb904174c1b9e222aa7c39))
* **behavior:** implement stopOnMatch multi-match semantics for DM patterns ([786c4f0](https://github.com/karyl-chan/karyl-chan/commit/786c4f07d483a7b6acc6829f82450077dd50e74a))
* **behavior:** operational surface — stats, test-fire, sessions, per-behavior TTL ([24c96c5](https://github.com/karyl-chan/karyl-chan/commit/24c96c54e381f7ab245fb0db82b094c16abc447a))
* **behavior:** webhook response embeds + admin-defined slash options ([f8b6d9e](https://github.com/karyl-chan/karyl-chan/commit/f8b6d9e32c841f8fb8071169bd289f7fb95361bd))
* **behavior:** widen session key to (userId, channelId) ([980b748](https://github.com/karyl-chan/karyl-chan/commit/980b7483dd24cb7339a1e47f94760b4fb8103985))
* **bot,plugin-sdk:** name the awaiting-register failure state everywhere (PM-7.6) ([d034865](https://github.com/karyl-chan/karyl-chan/commit/d03486539f12e542360a8f4ef4d45479bd00fe2c))
* **bot:** decouple register response from Discord command sync (PM-7.1) ([732fae2](https://github.com/karyl-chan/karyl-chan/commit/732fae22a14d107c5c3bc2a2a43da5542e936785))
* **bot:** diff-based command sync + explicit rate-limit handling (PM-7.3) ([e075b0f](https://github.com/karyl-chan/karyl-chan/commit/e075b0f171004ddd4804e5e7628521eb92b8e0c3))
* **bot:** pr-0.2 structured logs with OTel trace correlation ([000c23a](https://github.com/karyl-chan/karyl-chan/commit/000c23af1da3ebdceee96dee8398d69d3a77251e))
* **bot:** pr-0.3 stamp service label on all metrics for log/metric parity ([1119fc8](https://github.com/karyl-chan/karyl-chan/commit/1119fc8ba3bb7e522ee59fc831e347739aedb0c1))
* **bot:** pr-1.2 bridge routes to redis-streams bus with HTTP fallback ([983a59d](https://github.com/karyl-chan/karyl-chan/commit/983a59d15d177125103477c5b063fe72e93abb32))
* **bot:** pr-2.2 SQLite→Postgres data migration script ([855faab](https://github.com/karyl-chan/karyl-chan/commit/855faab2293e2506c0c2d3533a56eb8caaa9e896))
* **bot:** pr-3.1 plugin dynamic registration — address TTL + multi-endpoint + graceful deregister ([a4aa980](https://github.com/karyl-chan/karyl-chan/commit/a4aa9801fad91b4a621594294020d2fa373d34e9))
* **bot:** pr-3.2 environment-native service discovery adapter ([5f68840](https://github.com/karyl-chan/karyl-chan/commit/5f6884018efd0e92e9eee8a616dc70ae82fda5bf))
* **bot:** pr-3.3 shard-aware cross-shard forward ([5d6dc0f](https://github.com/karyl-chan/karyl-chan/commit/5d6dc0fd30330766db5758aad71902cba2968f85))
* **bot:** pr-5.1 central SecretProvider + HMAC rotation window ([ea899fc](https://github.com/karyl-chan/karyl-chan/commit/ea899fcb63428704de2ab0aa5e74381e713d907c))
* **frontend:** make header brand link to dashboard ([2573483](https://github.com/karyl-chan/karyl-chan/commit/25734835998878735f58688ca2006cf1c318cd27))
* **plugin-system:** admin RPC scope approval model (PM-3.1) ([bfc8622](https://github.com/karyl-chan/karyl-chan/commit/bfc8622d8eb81aa998441080fb893d2d7ab97a67))
* **plugin-system:** admin UI for RPC scope approve/deny (PM-3.2) ([1ff3a3e](https://github.com/karyl-chan/karyl-chan/commit/1ff3a3eaaf8df67575631609209dba9f758e8411))
* **security:** add a nonce to the bot↔plugin/webhook HMAC scheme ([a9459df](https://github.com/karyl-chan/karyl-chan/commit/a9459dfb3b04b1b307c430988de6ee79a100f43d))
* **voice-rpc:** structured voice.locate matches + names on status ([37abec6](https://github.com/karyl-chan/karyl-chan/commit/37abec69be995799c480faf129aefca4041e0576))
* **voice:** pr-2.3c relocate manager + standalone HTTP service ([bccf757](https://github.com/karyl-chan/karyl-chan/commit/bccf757190005b1fe903187555e9bde4f5d379be))
* **voice:** pr-2.3d bot-side RemoteVoiceBackend + gateway bridge wiring ([3f2760a](https://github.com/karyl-chan/karyl-chan/commit/3f2760aecdaab80d49a5b7e18300e1b032fd1c91))


### Bug Fixes

* **admin:** 404 when revoking a capability from a nonexistent role ([2c16f24](https://github.com/karyl-chan/karyl-chan/commit/2c16f24cbc1dcf8927f2762982586c6c5c5a70bd))
* **behavior:** clear opposite trigger columns when switching a custom behavior ([c1cf1ac](https://github.com/karyl-chan/karyl-chan/commit/c1cf1ac8f9981ba39becb23ad01c73166e277428))
* **behavior:** validate PATCH trigger sub-fields when triggerType is unchanged ([16368ac](https://github.com/karyl-chan/karyl-chan/commit/16368ac5af5fefa734a79097a467d9291bba49ad))
* **bootstrap:** make per-run handler registration idempotent across restarts ([c7e6f21](https://github.com/karyl-chan/karyl-chan/commit/c7e6f219242934781b771dfd2da607412672b426))
* **bot-events:** count the write metric only after the DB write lands ([776aedc](https://github.com/karyl-chan/karyl-chan/commit/776aedc84f399ce773c550c27b8743da241f5d45))
* **bot-events:** LRU-evict the dedup map so recurring keys aren't dropped mid-window ([27faa3c](https://github.com/karyl-chan/karyl-chan/commit/27faa3c3c58f3cbde154535bb2b662be34d2ac73))
* **bot-events:** make ?category=plugin actually filter (allowlist drift) ([5406426](https://github.com/karyl-chan/karyl-chan/commit/54064269e18bbe811371e98335eff9c4c9dc1e4d))
* **bot,e2e:** post-merge integration fixes for the bh + sse branches ([f41e2a2](https://github.com/karyl-chan/karyl-chan/commit/f41e2a230ac3799a65173fa2a519b077230bff94))
* **bot:** BOT_SKIP_DISCORD mode can reach ready (PM-7.5) ([ce170e1](https://github.com/karyl-chan/karyl-chan/commit/ce170e1fa9754760722200fdf5b7c2e8aaa1dd11))
* **bot:** build @karyl-chan/voice + plugin-sdk in the Docker image ([ba7c6f0](https://github.com/karyl-chan/karyl-chan/commit/ba7c6f02242555aaf3477709dece92fafb1ffeab))
* **bot:** never treat unverifiable guilds' command rows as stale (PM-7.4) ([46c46ff](https://github.com/karyl-chan/karyl-chan/commit/46c46ff645bbf0b4eb85db9ee112473e9ea93ecb))
* **bot:** pr-4.2 retry plugin-proxy upstream on recreate ECONNREFUSED ([4e231af](https://github.com/karyl-chan/karyl-chan/commit/4e231af8ca60e6df81684716bddf9176c2509bff))
* **bot:** test-typecheck fixes CI caught on the merged tree ([6bb8e00](https://github.com/karyl-chan/karyl-chan/commit/6bb8e007c72c103e288393fd2840edc565470f7a))
* **command-reconciler:** register commands created via incremental reconcile ([3d79fc9](https://github.com/karyl-chan/karyl-chan/commit/3d79fc907d6877736f30be82c337eaf26fbf7186))
* **command-reconciler:** report guild-scope create/patch, not always noop ([b393cb8](https://github.com/karyl-chan/karyl-chan/commit/b393cb856bdd39d42d387c7199e348d98db4cb6c))
* **discord-routes:** authz the message-forward route before the channel fetch ([7f14c6c](https://github.com/karyl-chan/karyl-chan/commit/7f14c6cc9398225c2c4124d399185cf0a7ce8525))
* **dm-inbox:** make recordActivity atomic to avoid lost-update race ([c409893](https://github.com/karyl-chan/karyl-chan/commit/c4098934fe1c9f6eabca10a7ca20714883c15afa))
* **dm-inbox:** re-sort conversations that received DMs while offline ([fef3c84](https://github.com/karyl-chan/karyl-chan/commit/fef3c840141aea7e6e8a439ec9a59d5cc8c18eca))
* **dm-sse:** replay missed events on reconnect instead of dropping them ([667af05](https://github.com/karyl-chan/karyl-chan/commit/667af052a06964872ea8c546c82600ac2f1ed0e3))
* **frontend:** apply role-capability edits as one batch ([923174e](https://github.com/karyl-chan/karyl-chan/commit/923174e3d59f7f6b741ef77762eee494598ef9ca))
* **frontend:** disabled plugin no longer shows running + disabled together ([88df0b3](https://github.com/karyl-chan/karyl-chan/commit/88df0b33830cccc5cacabd13fa003f9818f3cb10))
* **frontend:** don't poison the user-summary cache on a transient fetch failure ([0c1b815](https://github.com/karyl-chan/karyl-chan/commit/0c1b81532cb47bb6e4dd2061917ffe8ebf8aa8ed))
* **frontend:** restore header brand-&gt;dashboard link ([448237f](https://github.com/karyl-chan/karyl-chan/commit/448237f03778e4214eca8ebe29c80548d841dd58))
* **frontend:** strip the one-time login token from the URL before exchange ([b9ed798](https://github.com/karyl-chan/karyl-chan/commit/b9ed7982be50e011eb894408fd5e5c1f474f9ee6))
* **guild-settings:** merge systemChannelFlags PATCH instead of overwriting from zero ([7324594](https://github.com/karyl-chan/karyl-chan/commit/732459403c383a3dfcfd2378b7ccf1d85af52979))
* **guild-sse:** replay missed events on reconnect (port of the DM SSE fix) ([6f9566d](https://github.com/karyl-chan/karyl-chan/commit/6f9566d48aa57ab566225b3983cba7475324f083))
* **interaction-dispatcher:** ack an unclaimed autocomplete so it doesn't time out silently ([be04729](https://github.com/karyl-chan/karyl-chan/commit/be04729656bd35d546865731982bc701f5ce15b0))
* **picture-only:** don't delete bot/webhook messages ([aabd5d0](https://github.com/karyl-chan/karyl-chan/commit/aabd5d0326fe0456315194215b86dd57607c73e7))
* **plugin-reaper:** drop the dispatch pool for heartbeat-expired plugins ([1df8461](https://github.com/karyl-chan/karyl-chan/commit/1df84616a2374693aa85debdcadf002a3e6b4ed9))
* **plugin:** clear health + metrics snapshots on plugin delete ([662a0bf](https://github.com/karyl-chan/karyl-chan/commit/662a0bfcae3824dd92358f9bea6601451ecc9951))
* **plugin:** make heartbeat reaper sweep race-safe (TOCTOU) ([9c3dbea](https://github.com/karyl-chan/karyl-chan/commit/9c3dbea3dcab8eedef59a66bbd3feae1129a0c0a))
* **role-emoji:** don't revoke a role still granted by another emoji ([9723651](https://github.com/karyl-chan/karyl-chan/commit/97236515eedd6c83ae183293cf4d229c921aeb0f))
* **security:** bind plugin-session JWTs to a per-plugin signing key ([597f592](https://github.com/karyl-chan/karyl-chan/commit/597f59293befe3ae112f0d687189c308dcc2f581))
* **security:** block CGNAT 100.64/10 in the public-only webhook host policy ([ec6a434](https://github.com/karyl-chan/karyl-chan/commit/ec6a434f533d07238d4c29eedde00812fa721776))
* **security:** stop plugin-dispatch fetches from following redirects (SSRF) ([fde2574](https://github.com/karyl-chan/karyl-chan/commit/fde25745654b649f154c3b7b2f657c3c7d85c7d7))
* **security:** stop webhook forwarder from following redirects (SSRF bypass) ([54a9a7f](https://github.com/karyl-chan/karyl-chan/commit/54a9a7fbe524b5412fca472de245e2b981a97561))
* **voice-rpc:** recover voice.locate from stale voice-state cache via REST ([c84c4a1](https://github.com/karyl-chan/karyl-chan/commit/c84c4a1a6d4e2c89d86dd55c0ef9e3ecc3bd1430))
* **voice:** only relay OP4 voice-state-update on the gateway-send route ([edfd0c1](https://github.com/karyl-chan/karyl-chan/commit/edfd0c1baa5aba30aabc53d3980a8fd78e0978ba))
* **voice:** read VOICE_HMAC_SECRET fresh per use so rotation works ([e614244](https://github.com/karyl-chan/karyl-chan/commit/e61424470bb085244819a3ff3e12844858d9abd3))
* **webhook-forwarder:** fail closed when an hmac secret can't be decrypted ([bc0d6e7](https://github.com/karyl-chan/karyl-chan/commit/bc0d6e76072dd3623e5f89ac9d2572b9c9699596))

## [1.5.0](https://github.com/karyl-chan/karyl-chan/compare/bot-v1.4.1...bot-v1.5.0) (2026-06-07)


### Features

* **bot/i18n, sdk:** convert voice/rcon/todo/picture-only + add ctx.locale ([8180df1](https://github.com/karyl-chan/karyl-chan/commit/8180df11cfc3a6e104399f1e9d3f2463a94655a8))
* **bot/i18n:** i18next framework + role-emoji conversion ([cc7d767](https://github.com/karyl-chan/karyl-chan/commit/cc7d7671287d1631acd936b6a6e2def42f483974))
* **bot/i18n:** localize system behaviors + manual list + DM matcher ([6fd394a](https://github.com/karyl-chan/karyl-chan/commit/6fd394a7c66f050714e8b9f122c756a0515844c0))
* **bot/plugin-rpc:** me.enabled_guilds POST + storage.kv_list_values ([8cf8124](https://github.com/karyl-chan/karyl-chan/commit/8cf81246490fe0470c9022215373906a903437f9))
* **bot:** forward mentions + reply reference in plugin message events ([ae70340](https://github.com/karyl-chan/karyl-chan/commit/ae70340296b5603b90f995190e6eebe62bde1952))
* **sdk, bot:** forward descriptionLocalizations / nameLocalizations end-to-end ([c151367](https://github.com/karyl-chan/karyl-chan/commit/c151367080fd501bd579d74539d0e1b37fa3d279))
* **voice-rpc:** add voice.locate RPC to find a user's current VC ([967cd1a](https://github.com/karyl-chan/karyl-chan/commit/967cd1a0e739cddf7bb8aa946d7345b4ee2fba25))


### Bug Fixes

* **bot/i18n:** correctness fixes from extra-high code review ([f1ac2a4](https://github.com/karyl-chan/karyl-chan/commit/f1ac2a47954cc7e5cb866d703acbc4d679ff81a5))
* **bot/i18n:** locale-string polish — backticks + zh-CN colons ([3ea75a4](https://github.com/karyl-chan/karyl-chan/commit/3ea75a42cdf7b5913ad54fc14c43e7bbb346b870))
* **bot/redis-lock:** check deadline before SET, cap sleep by remaining ([8635af3](https://github.com/karyl-chan/karyl-chan/commit/8635af3053bfb037502fa530396b5e943b0ede6e))
* **bot:** restore EMOJI_REGEX lower bound to U+2000 (was U+0020) ([5850388](https://github.com/karyl-chan/karyl-chan/commit/5850388ad999ac463d6f82b7150f46eddf70e230))
* **sdk, bot:** accept both snake_case + camelCase localization fields ([0e88ae1](https://github.com/karyl-chan/karyl-chan/commit/0e88ae1ad8ed41c9f0d615e6719551067431d9f8))

## [1.4.1](https://github.com/karyl-chan/karyl-chan/compare/bot-v1.4.0...bot-v1.4.1) (2026-05-27)


### Bug Fixes

* **bot:** mock new plugin-event-bridge exports + drop umzug smoke test ([638b05e](https://github.com/karyl-chan/karyl-chan/commit/638b05e9ca1d639aff1a62be343221185cd8c33a))
* **bot:** reorder plugin-proxy test setup so sync() sees every model ([7233192](https://github.com/karyl-chan/karyl-chan/commit/7233192d14c256e46458f69ccfba9e38c487afba))
* **bot:** update config-metadata.test stub for new AppConfig fields ([8669254](https://github.com/karyl-chan/karyl-chan/commit/8669254ea663549d60dcf0bc84046372cb725272))

## [1.4.0](https://github.com/karyl-chan/karyl-chan/compare/bot-v1.3.0...bot-v1.4.0) (2026-05-28)


### ⚠ BREAKING CHANGES

* **bot:** remove proactive admin-login DM feature ([8bb0955](https://github.com/karyl-chan/karyl-chan/commit/8bb09557b53a307dd9373decadd7362217323789))
* **bot:** widen `SessionStore.verifyAccessToken` / `consumeSseTicket` / `revokeAccess` / `issueSseTicket` to `T | Promise<T>`; the Redis impl now returns Promises — callers must `await` ([d01a903](https://github.com/karyl-chan/karyl-chan/commit/d01a90384ca78bf2af61bf269b739414f808717a))

### Features

* **bot:** umzug-backed migration framework + baseline migration ([0ec3ed2](https://github.com/karyl-chan/karyl-chan/commit/0ec3ed2a907d9dcb35bd8eb5f50a32c7a862d190))
* **bot:** sharding-aware client + global reconcile gate ([7d44980](https://github.com/karyl-chan/karyl-chan/commit/7d44980a19b4b3d6c4ac22115824924e78181afc))
* **bot:** adapter interfaces for stores + lock (pluggable in-process / Redis backends) ([bfb6c7a](https://github.com/karyl-chan/karyl-chan/commit/bfb6c7a6f429b37b0f5755fdb44173f84f2fa29b))
* **bot:** plugin dispatch pool — keep-alive + circuit breaker + connect-refused retry ([68239da](https://github.com/karyl-chan/karyl-chan/commit/68239dadf4236c0d2bc0fefd49b69208c46be8c9))
* **bot:** incremental event-index updates ([d9dbc15](https://github.com/karyl-chan/karyl-chan/commit/d9dbc155d0ce41758aa974b1e38d7da170876ad2))
* **bot:** plugin proxy lookup cache ([7424098](https://github.com/karyl-chan/karyl-chan/commit/7424098979fab6e1d72e244704135c121c09e87f))
* **bot:** graceful drain — flip ready=false before close ([b1109fa](https://github.com/karyl-chan/karyl-chan/commit/b1109fa48f3efc2e493839d1c71c4a07db94ee97))
* **bot:** split bot_events into its own SQLite file (Postgres deploys share main connection) ([3ad5e0e](https://github.com/karyl-chan/karyl-chan/commit/3ad5e0e4a1ce1dfc83f096616b073e6bb7c81353))
* **bot:** plugin dispatch metrics (latency + breaker open gauge) ([377793d](https://github.com/karyl-chan/karyl-chan/commit/377793dd8109c6da0b4b8210c090240f1477482d))
* **bot:** trace context pre-wiring (W3C `traceparent` headers) ([e948fc7](https://github.com/karyl-chan/karyl-chan/commit/e948fc7fec7c25b5d273f83a8420add5e4e3973a))
* **bot:** Redis SessionStore + adapter registry hook ([c049e62](https://github.com/karyl-chan/karyl-chan/commit/c049e6246861e84f1f850decc86c8b19afbf45f2))
* **bot:** Redis RateLimitStore factory ([9261032](https://github.com/karyl-chan/karyl-chan/commit/92610321f01854796695df3b976f75b072e81ba9))
* **bot:** Redis PluginMetricsStore + PluginHealthStore ([ea334d7](https://github.com/karyl-chan/karyl-chan/commit/ea334d7f3d4904ce0435d86772464c2c7cda4348))
* **bot:** Redis DistributedLock (SETNX + Lua release) ([95b2c24](https://github.com/karyl-chan/karyl-chan/commit/95b2c24527a0d8f8b9246cafefbaffb2a741afbb))
* **bot:** `DB_URL` dialect dispatch (sqlite | postgres) ([3cba37a](https://github.com/karyl-chan/karyl-chan/commit/3cba37a4f3145d3cd09deefaf313dd73405a65c7))
* **bot:** Redis Streams EventBus producer ([b0fcb71](https://github.com/karyl-chan/karyl-chan/commit/b0fcb71e8533f1480f58fb2580a9f0dfc2b3c1ce))
* **bot:** voice admission control (per-process concurrent guild cap, `MAX_CONCURRENT_VOICE_GUILDS`) ([dac2053](https://github.com/karyl-chan/karyl-chan/commit/dac205331f44007be762ea3b9981808cb002c3b0))
* **bot:** shard-aware routing helpers (`targetShardForGuild` / `isMyShard`) ([b6389f7](https://github.com/karyl-chan/karyl-chan/commit/b6389f76536a102cf635fb102699d2aad7de1c28))

### Bug Fixes

* **bot:** static-import Redis adapters so registry works under ESM (was: `ReferenceError: require is not defined` on any `*_STORE=redis`) ([0f46a92](https://github.com/karyl-chan/karyl-chan/commit/0f46a92e56d1f8d140e717c536b001805da20e3e))
* **bot:** catch SET errors in distributed-lock acquire loop so a Redis blip doesn't `process.exit` ([14d461d](https://github.com/karyl-chan/karyl-chan/commit/14d461de2ad61e437a1c31834843049a0b1cdc20))
* **bot:** await `setHealth` in 5 plugin-health-poller call sites ([7e6d475](https://github.com/karyl-chan/karyl-chan/commit/7e6d475a7a4bcc5276e4aa49a33325c5ea0f3605))
* **bot:** await `setSnapshot` in plugin metrics RPC ([077d30e](https://github.com/karyl-chan/karyl-chan/commit/077d30e81cc0d4a47849d2c9b263a0cfa1ffd390))
* **bot:** atomic GETDEL Lua script for `rotateRefresh` (refresh-token reuse detection wasn't atomic) ([7400195](https://github.com/karyl-chan/karyl-chan/commit/7400195b9038d2e3be16be44bcec5872d760612c))
* **bot:** only extend owner-index TTL, never shrink (revokeOwner could silently miss valid tokens) ([8e9c259](https://github.com/karyl-chan/karyl-chan/commit/8e9c25967bf2c5a12342be25d98eb06edc42c486))
* **bot:** only claim half-open probe slot after in-flight cap passes (breaker could wedge open forever) ([a1ee71a](https://github.com/karyl-chan/karyl-chan/commit/a1ee71ae2ba0d9c025e30b682a46c707e82ccc9c))
* **bot:** drop dispatch pool entry on plugin delete + register (tripped breaker survived re-register) ([c9f7e68](https://github.com/karyl-chan/karyl-chan/commit/c9f7e684e17ebb426af722cfeba1e822e6a32556))
* **bot:** fail-fast when `SHARD_ID >= TOTAL_SHARDS` (was: silent black-hole shard) ([8ec30e7](https://github.com/karyl-chan/karyl-chan/commit/8ec30e79fc6ab394749fa37e402a8e8479912817))
* **bot:** catch `VoiceCapacityError` in `/voice join` slash handler ([c04077b](https://github.com/karyl-chan/karyl-chan/commit/c04077b5a7a0f50fc6c57a5fc290cd442caf16e9))
* **bot:** invalidate cache/index when heartbeat revives an inactive plugin ([dd2e66a](https://github.com/karyl-chan/karyl-chan/commit/dd2e66af600079461b31c14a70ce7512068a40e4))
* **bot:** gate plugin reaper to shard 0 in multi-shard deployments ([ad8c379](https://github.com/karyl-chan/karyl-chan/commit/ad8c37903f29c3b765c722e08e7b5362383f1367))
* **bot:** share main DB connection for bot_events under Postgres (was: split-brain audit log across shards) ([52a9262](https://github.com/karyl-chan/karyl-chan/commit/52a9262966f7db876c2e62ecc5db476befc530c9))
* **bot:** implement real `isLeader` election for `RedisDistributedLock` ([986a4ed](https://github.com/karyl-chan/karyl-chan/commit/986a4ed2004baff2cc3287222a180ec8e10fa309))
* **bot:** classify `bot.shardId` / `bot.totalShards` in config-metadata ([344477a](https://github.com/karyl-chan/karyl-chan/commit/344477afd8a24ae865086aed6dac824978748509))
* **bot:** classify `db.botEventsSqlitePath` in config-metadata ([6a6b052](https://github.com/karyl-chan/karyl-chan/commit/6a6b052c01a76c0dd05db3f6f1febd2b4e726c6a))
* **bot:** correct DEFAULT path computation for sqlite files (was resolving to a non-writable container path) ([14b36b9](https://github.com/karyl-chan/karyl-chan/commit/14b36b90f0eb7eeb312006e042f78c14e57e0d4e))
* **bot:** catch global-command-reconcile timeout so bot doesn't crashloop on slow Discord rate-limit ([59431d7](https://github.com/karyl-chan/karyl-chan/commit/59431d7db13aad5c8c74121cfcf4dc4eba808c29))

### Refactors

* **bot:** adopt `AppButton` for action buttons across admin pages ([be1e2f2](https://github.com/karyl-chan/karyl-chan/commit/be1e2f26d36b2dfb1f3edf7b3d6bcaeec8d6f6f6))
* **bot:** route overlay Escape through `useEscapeStack` ([c2bba20](https://github.com/karyl-chan/karyl-chan/commit/c2bba20))
* **bot:** replace raw `<input>` / `<textarea>` form fields with `AppTextField` / `AppTextArea` ([111e98d](https://github.com/karyl-chan/karyl-chan/commit/111e98d))
* **bot:** replace per-page badge/pill/chip with `AppBadge` ([7d811da](https://github.com/karyl-chan/karyl-chan/commit/7d811da))
* **bot:** plugin config boolean field uses `AppToggle` ([d423609](https://github.com/karyl-chan/karyl-chan/commit/d423609))

### Chores

* strip dev-process markers from comments; remove `adapters/README.md` ([78dc42d](https://github.com/karyl-chan/karyl-chan/commit/78dc42d))

## [1.3.0](https://github.com/karyl-chan/karyl-chan/compare/bot-v1.2.0...bot-v1.3.0) (2026-05-26)


### Features

* **bot, sdk:** validateManifest accepts the new auto-stamped `sdk_version` field; registry log records it for per-version compatibility shims ([159ac9c](https://github.com/karyl-chan/karyl-chan/commit/159ac9c3ccba39bfbb43fd7d76d927faad2ae894))


### Bug Fixes

* **bot/dockerfile:** source-rebuild sqlite3 after pnpm deploy so the runtime image links against bullseye's glibc 2.31 ([fe1e1eb](https://github.com/karyl-chan/karyl-chan/commit/fe1e1ebbecca31d525b6c75088d87685395dd7d8))
* **ui:** AppBadge icon sizing — drop the unreliable :width ref, sized via 1em font-size inheritance ([5268e4a](https://github.com/karyl-chan/karyl-chan/commit/5268e4a))
* **ui:** AppTabs full-width root + suppress implicit vertical scroll ([ba5cfd2](https://github.com/karyl-chan/karyl-chan/commit/ba5cfd2))


### Refactors

* **bot/frontend:** rebuild PluginCard on AppItemCard + AppMenu so the kebab + collapse share chrome with BehaviorCard ([763011f](https://github.com/karyl-chan/karyl-chan/commit/763011f))
* **bot/frontend:** rebuild BehaviorCard on AppItemCard — drop the per-page card chrome and adopt the shared slot-driven list-card primitive ([b50e19e](https://github.com/karyl-chan/karyl-chan/commit/b50e19e))

## [1.2.0](https://github.com/karyl-chan/karyl-chan/compare/bot-v1.1.0...bot-v1.2.0) (2026-05-26)


### Features

* **bot, sdk:** SDK audit cleanup — 8 outdated docs / questionable designs ([92dbef3](https://github.com/karyl-chan/karyl-chan/commit/92dbef3206894bc5ae33489ef7bba1b0004d43e9))
* **bot,sdk:** defer reads default_ephemeral; mismatch via DELETE [@original](https://github.com/original) ([58e24cf](https://github.com/karyl-chan/karyl-chan/commit/58e24cfef1cee80513ff41e40b452c46ac17ee2b))


### Bug Fixes

* **bot:** respond endpoint must distinguish deferReply vs deferUpdate ([0098632](https://github.com/karyl-chan/karyl-chan/commit/00986326c21ad26048aa85b19f54552059e01bfc))

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

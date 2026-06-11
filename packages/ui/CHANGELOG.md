# Changelog

## [0.3.0](https://github.com/karyl-chan/karyl-chan/compare/ui-v0.2.0...ui-v0.3.0) (2026-06-11)


### ⚠ BREAKING CHANGES

* **ui:** AppModal now pads its body by default; slot content with its own outer padding will double-pad. Either remove the caller's wrapper padding or pass padding="0".

### Features

* **ui:** AppModal pads body by default via padding prop ([c6c0cdc](https://github.com/karyl-chan/karyl-chan/commit/c6c0cdc1d4a6eced05904f6858fbdf477697193f))

## [0.2.0](https://github.com/karyl-chan/karyl-chan/compare/ui-v0.1.0...ui-v0.2.0) (2026-05-27)


### Features

* **ui:** add AppBadge with dual tone/variant axes ([18783f1](https://github.com/karyl-chan/karyl-chan/commit/18783f121f9918be9f9ad9c7bccc1a813e5b287d))
* **ui:** add AppItemCard composite ([20a6e24](https://github.com/karyl-chan/karyl-chan/commit/20a6e244c8127c641b7e342af610cf016c8439a5))
* **ui:** add AppTextField and AppTextArea ([941e833](https://github.com/karyl-chan/karyl-chan/commit/941e833f6c0420ef739c486afce02ded06da4df2))
* **ui:** add AppToggle switch ([a269cd5](https://github.com/karyl-chan/karyl-chan/commit/a269cd56a919c86631825d803011faece9dd4a5a))
* **ui:** add useColorScheme composable with light/dark/system override ([694b2f2](https://github.com/karyl-chan/karyl-chan/commit/694b2f2cf73459a1e92a63f997ca07083f0f9128))
* **ui:** add UserAvatar / UserItem / UserCard with animated-asset support ([119a1d3](https://github.com/karyl-chan/karyl-chan/commit/119a1d39aab1717fc91344d2cf07fdc88c4d4230))
* **ui:** AppTextField honours v-model .number / .trim modifiers ([9c9705f](https://github.com/karyl-chan/karyl-chan/commit/9c9705fb7b169f7520213f0b53c70fd7d570b03f))
* **ui:** AppTextField/AppTextArea forward autofocus + required ([01479c7](https://github.com/karyl-chan/karyl-chan/commit/01479c783c2fbd95971195c280c5f32bd30338b4))
* **ui:** extract @karyl-chan/ui from bot frontend ([fce60e2](https://github.com/karyl-chan/karyl-chan/commit/fce60e288a331d4002fd53c6e89acaa9afd36f9f))


### Bug Fixes

* build-verification fixups after UI extraction ([73e48e8](https://github.com/karyl-chan/karyl-chan/commit/73e48e808ca4009abd9a8baf00cc871c33e5e57c))
* **sdk, plugin-example:** address Phase 6 review findings ([0d4d3ee](https://github.com/karyl-chan/karyl-chan/commit/0d4d3eecade3775ee09dccf349639db0ce13451a))
* **ui:** AppBadge icon sizing — drop unreliable :width ref, use 1em ([5268e4a](https://github.com/karyl-chan/karyl-chan/commit/5268e4a8beee6d8fc9b2245ca145b91149a9ac34))
* **ui:** AppButton drops empty label span for icon-only usage ([2342ba9](https://github.com/karyl-chan/karyl-chan/commit/2342ba9f3f5fab8b2808c567761485858b62185f))
* **ui:** AppTabs full-width root + suppress implicit vertical scroll ([ba5cfd2](https://github.com/karyl-chan/karyl-chan/commit/ba5cfd21b7569d799a6f4e6532638777d943ae3f))
* **ui:** move .npmignore under src so files-whitelist honors it ([8375130](https://github.com/karyl-chan/karyl-chan/commit/8375130110e5edcfdfc7ca0289dcb4c010e4ab90))

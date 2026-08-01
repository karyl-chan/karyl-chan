/**
 * Plugin manifest wire types.
 *
 * These live in `@karyl-chan/plugin-wire` — the single home for the
 * bot↔plugin wire contract — and are re-exported here so plugin authors
 * keep importing them from `@karyl-chan/plugin-sdk` unchanged. The SDK
 * build vendors plugin-wire into `dist` (see
 * `docs/adr/0001-plugin-wire-private-vendored-into-sdk.md`), so this
 * re-export inlines at publish time — consumers never see a bare
 * `@karyl-chan/plugin-wire` import.
 *
 * Note the split from `./types.ts`: the plugin-author-facing
 * `CommandOption` input type (which also accepts the numeric
 * `ApplicationCommandOptionType` enum) stays there; `buildManifest`
 * normalizes it into the on-wire `ManifestCommandOption` re-exported
 * here.
 */
export type {
  ConfigFieldType,
  CommandOptionType,
  ManifestConfigField,
  ManifestCommandOption,
  ManifestGuildFeature,
  ManifestCommand,
  ManifestPluginCommand,
  ManifestCapability,
  PluginManifest,
} from "@karyl-chan/plugin-wire";

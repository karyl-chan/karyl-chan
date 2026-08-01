/**
 * `@karyl-chan/plugin-wire` — the single home for the bot↔plugin wire
 * contract. See `packages/plugin-wire/CONTEXT.md` for the glossary
 * (Wire Contract, Canonical Event, Event Ceiling, Compat Floor).
 *
 * Workspace-private, never published: the bot and frontend import it via
 * `workspace:*`; the published `@karyl-chan/plugin-sdk` vendors it into
 * `dist` at build time (see
 * `docs/adr/0001-plugin-wire-private-vendored-into-sdk.md`).
 */

// Canonical Events + the version-introduction ledger.
export { Events, CANONICAL_EVENTS, isCanonicalEvent } from "./events.js";
export type { EventName } from "./events.js";

// Event Ceiling + the unknown-subscription verdict it drives.
export { EVENT_CEILING, classifyEventSubscription } from "./event-ceiling.js";

// SDK-version comparison used across the contract's compat statements.
export { compareSemver, maxSemver } from "./semver.js";

// Manifest contract: the register document + every nested wire shape,
// and the config-field / command-option scope vocabularies.
export { CONFIG_FIELD_TYPES, COMMAND_OPTION_TYPES } from "./manifest.js";
export type {
  ConfigFieldType,
  CommandOptionType,
  ManifestCommandOption,
  ManifestConfigField,
  ManifestCommand,
  ManifestPluginCommand,
  ManifestCapability,
  ManifestGuildFeature,
  PluginManifest,
} from "./manifest.js";

// Protocol validation for the register document — the rules both sides
// of the wire enforce (the bot at register, the SDK at build).
export {
  validateManifestProtocol,
  MAX_PLUGIN_CAPABILITIES,
} from "./validate-manifest.js";
export type { ManifestValidation } from "./validate-manifest.js";

// Config-field validity: is the declaration well-formed, and does a
// value satisfy it. The bot's admin-save orchestration wraps these.
export { validateConfigSchema, validateConfigValue } from "./validate-config.js";
export type {
  ConfigFieldError,
  ConfigFieldErrorCode,
} from "./validate-config.js";

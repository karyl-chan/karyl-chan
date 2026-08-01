/**
 * Plugin manifest — the top-level document a plugin POSTs to
 * `/api/plugins/register`, and every nested wire shape it carries. This
 * is the single home for the manifest contract: the bot validates
 * against these shapes, the SDK's `buildManifest` emits them, and the
 * admin frontend renders them. Fields are the on-wire (post-normalize)
 * form — snake_case where Discord/the bot use snake_case, camelCase for
 * the storage block the bot persists.
 */

// ─── Scope vocabularies ────────────────────────────────────────────────
// The closed sets of config-field and command-option types. Exported as
// runtime arrays (not just unions) so validation can check membership
// without re-listing the vocabulary.

/** Admin-config field types the manifest may declare. */
export const CONFIG_FIELD_TYPES = [
  "text",
  "textarea",
  "number",
  "boolean",
  "select",
  "channel",
  "role",
  "user",
  "url",
  "secret",
  "regex",
] as const;
export type ConfigFieldType = (typeof CONFIG_FIELD_TYPES)[number];

/** Slash-command option types, in the on-wire string form. The SDK's
 *  author-facing `CommandOption` additionally accepts the numeric
 *  `ApplicationCommandOptionType` enum and normalizes to these strings
 *  before the manifest reaches the wire. */
export const COMMAND_OPTION_TYPES = [
  "string",
  "integer",
  "boolean",
  "number",
  "channel",
  "user",
  "role",
  "mentionable",
  "attachment",
  "sub_command",
  "sub_command_group",
] as const;
export type CommandOptionType = (typeof COMMAND_OPTION_TYPES)[number];

// ─── Command options ───────────────────────────────────────────────────

/**
 * A slash-command option in its on-wire form. `type` is the normalized
 * string (validated against `COMMAND_OPTION_TYPES`) — the SDK's
 * `buildManifest` has already coerced any numeric
 * `ApplicationCommandOptionType` the author used. `choices` values are
 * the resolved primitives Discord accepts.
 */
export interface ManifestCommandOption {
  type: string;
  name: string;
  description?: string;
  /** Per-locale `description` overrides keyed by Discord locale tag
   *  (`en-US`, `zh-TW`, …). Forwarded to Discord's
   *  `description_localizations` at command registration. */
  description_localizations?: Record<string, string>;
  /** Per-locale `name` overrides (same shape). */
  name_localizations?: Record<string, string>;
  required?: boolean;
  /** Restrict a channel option to specific channel types. */
  channel_types?: string[];
  /** Nested options for `sub_command` / `sub_command_group`. */
  options?: ManifestCommandOption[];
  choices?: Array<{ name: string; value: string | number }>;
  /** String / integer / number options can declare `autocomplete: true`;
   *  routed via `/commands/{name}/autocomplete`. */
  autocomplete?: boolean;
  /** Numeric range (integer / number options). */
  min_value?: number;
  max_value?: number;
  /** String length range (string options). */
  min_length?: number;
  max_length?: number;
}

// ─── Config schema ─────────────────────────────────────────────────────

/**
 * One admin-editable config field. `default`'s runtime type must match
 * `type` (register-time validation rejects mismatch), and the
 * constraint fields (`min`/`max`/`step`/`pattern`) are ignored for
 * inapplicable types.
 */
export interface ManifestConfigField {
  key: string;
  type: ConfigFieldType;
  label: string;
  description?: string;
  required?: boolean;
  /** Narrowed from `unknown` — the register-time validator rejects a
   *  `default` whose runtime type doesn't match `type`. */
  default?: string | number | boolean | null;
  options?: Array<{ value: string; label: string }>;

  /** Number: inclusive min value. String types: min character length. */
  min?: number;
  /** Number: inclusive max value. String types: max character length. */
  max?: number;
  /** Number type: UI step attribute. Ignored on save. */
  step?: number;
  /** ECMAScript regex source (text/textarea/url/regex). Compiled at
   *  register-time (invalid → manifest rejected) and applied on save. */
  pattern?: string;
}

// ─── Commands ──────────────────────────────────────────────────────────

/**
 * A guild-feature slash command (track 1). Registers per-guild and is
 * gated by the feature's per-guild toggle. `scope` / `contexts` /
 * `integration_types` are optional here (unlike plugin commands).
 */
export interface ManifestCommand {
  name: string;
  description: string;
  description_localizations?: Record<string, string>;
  name_localizations?: Record<string, string>;
  scope?: "guild" | "global";
  /** Discord permission bitfield key name string, e.g. "ManageGuild". */
  default_member_permissions?: string;
  /** Whether the bot defers this command's reply as ephemeral. Default
   *  `true` when omitted. Handlers can still flip per-call via
   *  `CommandReply.ephemeral`. */
  default_ephemeral?: boolean;
  required_capability?: string;
  dm_permission?: boolean;
  /** Discord interaction-context restriction (modern replacement for
   *  `dm_permission`). Omitted → Discord's default (`["Guild"]`). */
  contexts?: ("Guild" | "BotDM" | "PrivateChannel")[];
  /** Where the bot can be installed for this command to be visible.
   *  Omitted → Discord defaults to `["guild_install"]`. */
  integration_types?: ("guild_install" | "user_install")[];
  options?: ManifestCommandOption[];
  /** `true` for commands whose handler opens a modal — the bot skips
   *  defer (Discord rejects modal-after-defer) and the plugin calls
   *  `interactions.send_modal` within the 3 s window. Default `false`. */
  modal?: boolean;
}

/**
 * A plugin-owned slash command (track 3). The manifest hard-codes the
 * three axes (`scope` / `integration_types` / `contexts`); the admin can
 * only toggle the command on/off. The bot's `validateManifest` rejects
 * any manifest that violates the axis rules (V-05..V-08).
 */
export interface ManifestPluginCommand {
  /** Discord slash-command name, `[a-z0-9][a-z0-9-]{0,31}`. */
  name: string;
  /** Required, non-empty (V-05). */
  description: string;
  description_localizations?: Record<string, string>;
  name_localizations?: Record<string, string>;
  /** V-06: must be "guild" or "global". */
  scope: "guild" | "global";
  /** V-07: must be a valid subset. */
  integration_types: Array<"guild_install" | "user_install">;
  /** V-08: must be a valid subset. */
  contexts: Array<"Guild" | "BotDM" | "PrivateChannel">;
  options?: ManifestCommandOption[];
  /** Discord permission bitfield key name string (manifest-locked). */
  default_member_permissions?: string;
  default_ephemeral?: boolean;
  required_capability?: string;
  /** Same shape as `ManifestCommand.modal`. */
  modal?: boolean;
}

// ─── Capabilities ──────────────────────────────────────────────────────

/**
 * One RBAC capability the plugin declares for itself. Persisted at
 * register; the admin "role permissions" modal opens a dedicated tab for
 * it. Token form: `plugin:<plugin.id>:<key>`.
 */
export interface ManifestCapability {
  /** Unique within the plugin, `[a-z0-9][a-z0-9._-]*`. */
  key: string;
  /** Admin-facing description (non-empty). */
  description: string;
}

// ─── Top-level manifest ────────────────────────────────────────────────

/**
 * The top-level plugin manifest POSTed to `/api/plugins/register`.
 *
 * No `schema_version` is required. Earlier builds carried
 * `schema_version: "1"` against a multi-version migration story that
 * never materialised (a literal type with a single value); it is kept
 * optional purely for backward-compat with manifests older SDKs still
 * post, and new plugins omit it. A real schema break would reintroduce
 * the field with a documented upgrade path, not assume one exists.
 */
export interface PluginManifest {
  /** Legacy; optional for backward compat. New plugins omit it. */
  schema_version?: string;
  /**
   * The `@karyl-chan/plugin-sdk` semver the plugin was built with,
   * auto-filled by `buildManifest`. The bot applies per-version compat
   * shims as the wire format evolves. Absent for pre-0.6 SDKs (treated
   * as "< 0.6").
   */
  sdk_version?: string;
  plugin: {
    id: string;
    name: string;
    version: string;
    description?: string;
    author?: string;
    homepage?: string;
    url: string;
    healthcheck_path?: string;
  };
  rpc_methods_used?: string[];
  storage?: {
    guildKv?: boolean;
    guildKvQuotaKb?: number;
    requiresSecrets?: boolean;
  };
  /** Plugin-level admin config; values persist in `plugin_configs`. */
  config_schema?: ManifestConfigField[];
  /**
   * Monotonically-incrementing integer on the `config_schema` block.
   * When the bot reads a config row whose stored schema version is lower
   * than this, it surfaces a stale-config warning in the admin UI —
   * without auto-migrating or rejecting the value. Default 1 when absent.
   */
  config_schema_version?: number;
  /** Track 1: guild features. */
  guild_features?: ManifestGuildFeature[];
  /** Track 3: plugin-owned commands (three axes manifest-locked). */
  plugin_commands?: ManifestPluginCommand[];
  /** RBAC capabilities the plugin declares for itself. */
  capabilities?: ManifestCapability[];
  /**
   * Browser-facing manage WebUI declaration. Present iff the plugin
   * declared `webUI`. The admin UI shows a "Manage" link to
   * `<publicBaseUrl><manage_path>` only when present; `manage_path`
   * defaults to `/manage`.
   */
  web_ui?: {
    manage_path?: string;
  };
  events_subscribed_global?: string[];
  endpoints?: {
    events?: string;
    plugin_command?: string;
    /** Plugin component (button + select) dispatch; defaults `/components`. */
    plugin_component?: string;
    /** Plugin autocomplete dispatch; defaults
     *  `/commands/{command_name}/autocomplete`. Present only when a
     *  command declares an autocomplete handler. */
    plugin_autocomplete?: string;
    /** Plugin modal-submit dispatch; defaults `/modals/{modal_id}`.
     *  Present only when the plugin declares modals. */
    plugin_modal?: string;
    guild_feature_action?: string;
    /** Rich health probe (`/health/detail`). The bot polls it every 60 s
     *  and on demand; the response is a HealthReport. Distinct from the
     *  lightweight `plugin.healthcheck_path` liveness probe. */
    health?: string;
    /** SDK-managed lifecycle dispatch. The bot POSTs synthetic
     *  `plugin.guild.enabled` / `plugin.guild.disabled` events here
     *  (HMAC-signed) when an admin toggles a guild-feature flag. Distinct
     *  from `events` so plugins own that route for their own subs. */
    plugin_lifecycle?: string;
  };
}

/**
 * Track 1: a guild feature — a togglable bundle of config + commands +
 * event subscriptions the admin flips per guild.
 */
export interface ManifestGuildFeature {
  key: string;
  name: string;
  icon?: string;
  description?: string;
  enabled_by_default?: boolean;
  events_subscribed?: string[];
  config_schema?: ManifestConfigField[];
  surfaces?: string[];
  /** Slash commands gated by this feature's per-guild toggle. */
  commands?: ManifestCommand[];
}

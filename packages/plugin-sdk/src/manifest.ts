import type { CommandOption } from "./types.js";

/**
 * Per-field config schema（供 admin UI 渲染用）。
 * 同 karyl-chan bot 端的 ManifestConfigField，此為 SDK 端的對應定義。
 */
export interface ManifestConfigField {
  key: string;
  type:
    | "text"
    | "textarea"
    | "number"
    | "boolean"
    | "select"
    | "channel"
    | "role"
    | "user"
    | "url"
    | "secret"
    | "regex";
  label: string;
  description?: string;
  required?: boolean;
  /**
   * Narrowed from `unknown` — the bot's register-time
   * `validateManifest` rejects manifests where `default`'s runtime type
   * doesn't match `type` (e.g. `default: 42` on a `type: "text"` field).
   * Caught at register time, not after admins start saving values.
   */
  default?: string | number | boolean | null;
  options?: Array<{ value: string; label: string }>;

  // ─── Constraint fields ─────────────────────────────────────────────
  // All optional; ignored for inapplicable types. The bot's
  // `validateConfigValue` runs these on every save and returns
  // per-field errors in a 422 response.

  /**
   * Number type: inclusive minimum value.
   * Text/textarea/url/regex/secret types: minimum character length.
   * Overloaded by type intentionally — keeps the surface tight without
   * a parallel `min`/`minLength` proliferation.
   */
  min?: number;
  /** Number: inclusive maximum value. String types: maximum length. */
  max?: number;
  /** Number type: UI step attribute. Ignored on save. */
  step?: number;
  /**
   * ECMAScript regex source string. Applied to text/textarea/url/regex
   * field values. Compiled with `new RegExp(pattern)`; an invalid
   * pattern is rejected at register-time, not silently dropped.
   */
  pattern?: string;
}

/**
 * Slash command option 定義。兩軌共用（軌一 guild_features.commands 與軌三
 * plugin_commands 皆使用）。Plugin 端 `CommandOption` 已含 `autocomplete /
 * min_value / max_value / min_length / max_length`；manifest 直接透傳，
 * bot 在 reconcile 給 Discord 時再轉成 numeric `ApplicationCommandOptionType`。
 */
export type ManifestCommandOption = CommandOption;

/**
 * 軌一：Guild Feature。
 * guild_features 內 commands[] 為 ManifestCommand 格式。
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
  /** guild-scoped slash commands，隨 feature toggle 管理。 */
  commands?: ManifestCommand[];
}

/** 內部用：guild_features[].commands[] 元素型別。 */
export interface ManifestCommand {
  name: string;
  description: string;
  /** Per-locale description overrides for Discord's command picker. */
  description_localizations?: Record<string, string>;
  /** Per-locale name overrides (Discord allows localized command names). */
  name_localizations?: Record<string, string>;
  scope?: "guild" | "global";
  default_member_permissions?: string;
  /**
   * Whether the bot defers this command's reply as ephemeral.
   * Defaults to `true` (private "thinking…" → private reply) when
   * omitted. Set to `false` to defer publicly — the channel will see
   * "thinking…" and the eventual reply. Plugin handlers can still flip
   * per-call via `CommandReply.ephemeral`; on mismatch the bot posts a
   * follow-up of the desired ephemerality and deletes `@original`.
   */
  default_ephemeral?: boolean;
  required_capability?: string;
  dm_permission?: boolean;
  contexts?: ("Guild" | "BotDM" | "PrivateChannel")[];
  integration_types?: ("guild_install" | "user_install")[];
  options?: ManifestCommandOption[];
  /**
   * `true` for commands whose handler opens a modal. The bot must
   * decide before dispatch whether to defer the reply (Discord rejects
   * modal-after-defer), so this flag is in the manifest. Default `false`
   * (regular deferred command; plugin completes via `interactions.respond`).
   */
  modal?: boolean;
}

/**
 * 軌三：Plugin 自訂指令（plugin 鎖死三軸，admin 只能 on/off）。
 * scope / integration_types / contexts 三欄全為必填；
 * bot 端 validateManifest 拒絕任何違反三軸規則的 manifest。
 */
export interface ManifestPluginCommand {
  /** Discord slash command name，格式 [a-z0-9][a-z0-9-]{0,31}。 */
  name: string;
  /** 指令說明文字。必填且必須是非空字串。 */
  description: string;
  /** Per-locale description overrides for Discord's command picker. */
  description_localizations?: Record<string, string>;
  /** Per-locale name overrides (Discord allows localized command names). */
  name_localizations?: Record<string, string>;
  /** 三軸：plugin manifest 寫死，admin 不可改。 */
  scope: "guild" | "global";
  integration_types: Array<"guild_install" | "user_install">;
  contexts: Array<"Guild" | "BotDM" | "PrivateChannel">;
  options?: ManifestCommandOption[];
  /**
   * Discord permission bitfield（plugin manifest 寫死，admin 不可改）。
   * PermissionFlagsBits key 名稱字串，例如 "ManageGuild"。
   */
  default_member_permissions?: string;
  /** See `ManifestCommand.default_ephemeral`. */
  default_ephemeral?: boolean;
  required_capability?: string;
  /** 同 ManifestCommand.modal — `true` 跳過 defer 並要求 sendModal。 */
  modal?: boolean;
}

/** Plugin 宣告的一個 RBAC capability 詞條（manifest 形式）。 */
export interface ManifestCapability {
  /** 詞條 key（plugin 內唯一），格式 [a-z0-9][a-z0-9._-]*。 */
  key: string;
  /** 給 admin 看的說明文字（非空）。 */
  description: string;
}

/**
 * Plugin Manifest 頂層結構。
 *
 * Pre-release status note: no `schema_version` field is required. Earlier
 * builds carried `schema_version: "1"` against a planned multi-version
 * migration story that never materialised — the field was a literal
 * type with no second value. Removed to cut noise. If/when a real
 * schema break ever happens it will reintroduce the field with a
 * documented upgrade path, not assume one already exists.
 */
export interface PluginManifest {
  /**
   * The `@karyl-chan/plugin-sdk` semver this plugin was built with.
   * SDK's `buildManifest` auto-fills this from the SDK package.json so
   * the bot can apply per-version compatibility shims as the wire
   * format evolves (e.g. retire a deprecated RPC path while the older
   * SDK is still in use). Optional only because pre-0.6 SDKs didn't
   * emit it — bot-side code treats absent as "unknown, < 0.6".
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
  /** Plugin 級 admin config。 */
  config_schema?: ManifestConfigField[];
  /**
   * Monotonically-incrementing integer on the manifest's
   * `config_schema` block. When the bot reads a persisted config row
   * whose stored schema version is lower than the manifest's declared
   * `config_schema_version`, it surfaces a stale-config warning in
   * the admin UI rather than auto-clearing or rejecting the value.
   * No migration is performed automatically — the plugin author owns
   * any data shape change. Default 1 when absent.
   */
  config_schema_version?: number;

  /** 軌一：Guild features。 */
  guild_features?: ManifestGuildFeature[];

  /** 軌三：Plugin 自訂指令（三軸寫死於 manifest）。 */
  plugin_commands?: ManifestPluginCommand[];

  /**
   * Plugin 自身需要的 RBAC capability 詞條。bot 端在 register 時持久化，
   * 並在 admin「身分組權限」modal 開專屬分頁；plugin 移除時一併清除。
   * 實際 token 形式 `plugin:<plugin.id>:<key>`。
   */
  capabilities?: ManifestCapability[];

  events_subscribed_global?: string[];

  endpoints?: {
    events?: string;
    plugin_command?: string;
    /** plugin 元件（按鈕 + select menu）互動派送端點；只有宣告 components 時才出現，預設 `/components`。 */
    plugin_component?: string;
    /**
     * Plugin autocomplete 派送端點；只有宣告了至少一個帶 `autocomplete` handler
     * 的 command 時才出現。預設 `/commands/{command_name}/autocomplete`。
     */
    plugin_autocomplete?: string;
    /**
     * Plugin modal-submit 派送端點；只有宣告了 modals 時才出現。
     * 預設 `/modals/{modal_id}`。
     */
    plugin_modal?: string;
    guild_feature_action?: string;
    /**
     * Rich health probe. The bot polls this every 60 s and on demand from
     * the admin UI; the response is a `HealthReport` (status / message /
     * checks). Distinct from `plugin.healthcheck_path` (which is the
     * lightweight liveness probe). Always present at `/health/detail`
     * when the SDK is used.
     */
    health?: string;
    /**
     * SDK-managed lifecycle dispatch endpoint. The bot POSTs synthetic
     * events (`plugin.guild.enabled` / `plugin.guild.disabled`) here in
     * HMAC-signed form whenever an admin toggles a guild-feature flag.
     * Distinct from `events` so plugins can own that route for their
     * own event subscriptions without colliding with lifecycle delivery.
     */
    plugin_lifecycle?: string;
  };
}

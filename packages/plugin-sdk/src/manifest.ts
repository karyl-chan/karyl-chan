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
  default?: unknown;
  options?: Array<{ value: string; label: string }>;
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
  overview_metrics?: Array<{ key: string; label: string; type: string }>;
  /** guild-scoped slash commands，隨 feature toggle 管理。 */
  commands?: ManifestCommand[];
}

/** 內部用：guild_features[].commands[] 元素型別。 */
export interface ManifestCommand {
  name: string;
  description: string;
  scope?: "guild" | "global";
  default_member_permissions?: string;
  default_ephemeral?: boolean;
  required_capability?: string;
  dm_permission?: boolean;
  contexts?: ("Guild" | "BotDM" | "PrivateChannel")[];
  integration_types?: ("guild_install" | "user_install")[];
  options?: ManifestCommandOption[];
  /**
   * What kind of initial response Discord expects: `"deferred"` (bot
   * `interaction.deferReply()`s and plugin completes via
   * `interactions.respond`) or `"modal"` (bot skips defer, plugin must
   * call `interactions.send_modal` within Discord's 3 s window).
   * Defaults to `"deferred"` when omitted.
   */
  response_kind?: "deferred" | "modal";
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
  default_ephemeral?: boolean;
  required_capability?: string;
  /** 同 ManifestCommand.response_kind — `"deferred"` (預設) 或 `"modal"`。 */
  response_kind?: "deferred" | "modal";
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
 * schema_version 必須是字串 "1"；bot 端 validateManifest 拒絕任何其他值。
 */
export interface PluginManifest {
  schema_version: "1";

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
    guild_kv?: boolean;
    guild_kv_quota_kb?: number;
    requires_secrets?: boolean;
  };
  /** Plugin 級 admin config。 */
  config_schema?: ManifestConfigField[];

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

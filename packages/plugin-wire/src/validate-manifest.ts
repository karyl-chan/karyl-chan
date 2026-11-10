import { validateConfigSchema } from "./validate-config.js";
import type {
  ManifestBehaviorAction,
  ManifestCapability,
  ManifestCommand,
  ManifestConfigField,
  ManifestGuildFeature,
  ManifestPluginCommand,
  PluginManifest,
} from "./manifest.js";

/**
 * Protocol validation for the register document.
 *
 * Every rule here is answerable from the manifest alone — the shape of
 * the document, the Discord constraints on command names/axes, the
 * closed vocabularies. Both sides of the wire run it: the bot on the
 * register path, the SDK's `buildManifest` at build time, so an author
 * learns about a malformed manifest at plugin startup rather than from
 * a 400 at register.
 *
 * What is deliberately NOT here: anything needing bot state. The
 * SSRF/host-policy check on `plugin.url` is the notable one — this
 * module confirms the URL parses and is http(s); whether that target is
 * *allowed* is the bot's call, applied after this returns.
 *
 * Rule IDs (V-01 ~ V-08, V-C1 ~ V-C3) trace to B-sdk §4; V-09 ~ V-12
 * (behavior_actions, #127) were added after it. V-01 was
 * `schema_version === "1"`; it now only rejects values other than
 * absent / null / "1" — see `isSupportedSchemaVersion` and `manifest.ts`.
 */

/** Hard cap on how many capabilities one plugin may declare. */
export const MAX_PLUGIN_CAPABILITIES = 32;

/** A behavior action key (V-09): like a command name, `_` allowed too. */
export const BEHAVIOR_ACTION_KEY_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;
/** How many behavior actions one plugin may declare (V-12). */
export const MAX_BEHAVIOR_ACTIONS = 25;
/** Caps on a behavior action's name and description (V-10). */
export const MAX_BEHAVIOR_ACTION_NAME = 100;
export const MAX_BEHAVIOR_ACTION_DESCRIPTION = 200;

/**
 * The V-10 rule for one of a behavior action's texts: what is wrong with
 * it ("must be a non-empty string", "must be ≤N chars"), or null. Shared
 * so the SDK's eager check says exactly what register would.
 */
export function behaviorActionTextProblem(
  field: "name" | "description",
  value: unknown,
): string | null {
  const max = field === "name" ? MAX_BEHAVIOR_ACTION_NAME : MAX_BEHAVIOR_ACTION_DESCRIPTION;
  if (typeof value !== "string" || value.trim().length === 0) return "must be a non-empty string";
  if (value.length > max) return `must be ≤${max} chars`;
  return null;
}

const VALID_INTEGRATION_TYPES = new Set(["guild_install", "user_install"]);
const VALID_CONTEXTS = new Set(["Guild", "BotDM", "PrivateChannel"]);

/** Discord's slash-command name constraint. */
const COMMAND_NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

export type ManifestValidation =
  | { ok: true; manifest: PluginManifest }
  | { ok: false; error: string };

function reject(error: string): { ok: false; error: string } {
  return { ok: false, error };
}

/**
 * The V-01 rule: which `schema_version` values this build understands.
 * The pre-release SDK dropped the field, so absent (and `null`) is fine,
 * as is the legacy `"1"`. Any other value signals a deliberate
 * future-schema attempt this build doesn't understand.
 *
 * Exported so the bot's track-3 command guard applies the exact rule
 * the register-time validation does, rather than a copy that can drift.
 */
export function isSupportedSchemaVersion(value: unknown): boolean {
  return value === undefined || value === null || value === "1";
}

export function validateManifestProtocol(input: unknown): ManifestValidation {
  if (!input || typeof input !== "object") {
    return reject("manifest must be an object");
  }
  const m = input as Record<string, unknown>;

  // V-01 — see `isSupportedSchemaVersion`.
  if (!isSupportedSchemaVersion(m.schema_version)) {
    return reject(
      `unsupported schema_version (got ${JSON.stringify(m.schema_version)})`,
    );
  }

  // sdk_version is informational metadata stamped by buildManifest from
  // the SDK's package.json. Required to be a semver-ish string when
  // present; absent is allowed (older SDKs didn't emit it). The bot uses
  // it for per-version compat shims and for the Event Ceiling verdict.
  if (m.sdk_version !== undefined && m.sdk_version !== null) {
    if (
      typeof m.sdk_version !== "string" ||
      !/^\d+\.\d+\.\d+(-[A-Za-z0-9.-]+)?$/.test(m.sdk_version)
    ) {
      return reject(
        `manifest.sdk_version must be a semver string (got ${JSON.stringify(m.sdk_version)})`,
      );
    }
  }

  // V-02：plugin.id 格式
  const plugin = m.plugin as Record<string, unknown> | undefined;
  if (!plugin || typeof plugin !== "object") {
    return reject("manifest.plugin missing");
  }
  for (const k of ["id", "name", "version", "url"] as const) {
    if (typeof plugin[k] !== "string" || (plugin[k] as string).length === 0) {
      return reject(`manifest.plugin.${k} required`);
    }
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(plugin.id as string)) {
    return reject("manifest.plugin.id must match [a-z0-9][a-z0-9-]*");
  }

  // V-03：plugin.url 必須 parse 得出來且是 http/https。呼叫端的 SSRF
  // guard（bot 專屬）在這之後才跑。
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(plugin.url as string);
  } catch {
    return reject("manifest.plugin.url is not a valid URL");
  }
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    return reject("manifest.plugin.url must be http(s)");
  }

  // V-04：plugin_commands / guild_features / … 若存在必須是 array
  for (const k of [
    "rpc_methods_used",
    "plugin_commands",
    "guild_features",
    "capabilities",
    "events_subscribed_global",
    "behavior_actions",
  ] as const) {
    if (m[k] !== undefined && !Array.isArray(m[k])) {
      return reject(`manifest.${k} must be an array`);
    }
  }

  // ── capabilities[] 驗證 ──────────────────────────────────────────────
  // key 格式 [a-z0-9][a-z0-9._-]*、description 非空、key 不重複、≤32 個。
  const capabilities = (m.capabilities as ManifestCapability[] | undefined) ?? [];
  if (capabilities.length > MAX_PLUGIN_CAPABILITIES) {
    return reject(
      `manifest.capabilities: at most ${MAX_PLUGIN_CAPABILITIES} allowed (got ${capabilities.length})`,
    );
  }
  const seenCapKeys = new Set<string>();
  for (let i = 0; i < capabilities.length; i++) {
    const c = capabilities[i];
    if (!c || typeof c !== "object") {
      return reject(`capabilities[${i}] must be an object`);
    }
    if (typeof c.key !== "string" || !/^[a-z0-9][a-z0-9._-]*$/.test(c.key)) {
      return reject(
        `capabilities[${i}].key "${String(c.key)}" must match [a-z0-9][a-z0-9._-]*`,
      );
    }
    if (typeof c.description !== "string" || c.description.trim().length === 0) {
      return reject(
        `capabilities[${c.key}].description must be a non-empty string`,
      );
    }
    if (c.description.length > 200) {
      return reject(`capabilities[${c.key}].description must be ≤200 chars`);
    }
    if (seenCapKeys.has(c.key)) {
      return reject(`capabilities[${c.key}].key is declared more than once`);
    }
    seenCapKeys.add(c.key);
  }

  // ── behavior_actions[] 驗證（V-09 ~ V-12）──────────────────────────────
  const behaviorActions =
    (m.behavior_actions as ManifestBehaviorAction[] | undefined) ?? [];
  // V-12：數量上限
  if (behaviorActions.length > MAX_BEHAVIOR_ACTIONS) {
    return reject(
      `manifest.behavior_actions: at most ${MAX_BEHAVIOR_ACTIONS} allowed (got ${behaviorActions.length}) (V-12)`,
    );
  }
  const seenActionKeys = new Set<string>();
  for (let i = 0; i < behaviorActions.length; i++) {
    const a = behaviorActions[i];
    // V-09：物件，key 格式
    if (!a || typeof a !== "object" || Array.isArray(a)) {
      return reject(`behavior_actions[${i}] must be an object (V-09)`);
    }
    if (typeof a.key !== "string" || !BEHAVIOR_ACTION_KEY_PATTERN.test(a.key)) {
      return reject(
        `behavior_actions[${i}].key "${String(a.key)}" must match ${BEHAVIOR_ACTION_KEY_PATTERN.source} (V-09)`,
      );
    }
    // V-10：name / description 必填、非空、有上限
    for (const field of ["name", "description"] as const) {
      const problem = behaviorActionTextProblem(field, a[field]);
      if (problem) return reject(`behavior_actions[${a.key}].${field} ${problem} (V-10)`);
    }
    // V-11：key 不重複
    if (seenActionKeys.has(a.key)) {
      return reject(`behavior_actions[${a.key}].key is declared more than once (V-11)`);
    }
    seenActionKeys.add(a.key);
  }

  // ── plugin_commands[] 驗證（V-05 ~ V-08、V-C1 / V-C2 / V-C3）─────────
  const pluginCommands =
    (m.plugin_commands as ManifestPluginCommand[] | undefined) ?? [];
  const seenPluginCommandNames = new Set<string>();
  for (let i = 0; i < pluginCommands.length; i++) {
    const cmd = pluginCommands[i];
    if (!cmd || typeof cmd !== "object") {
      return reject(`plugin_commands[${i}] must be an object`);
    }

    // V-05：description 必須是非空字串
    if (
      !cmd.description ||
      typeof cmd.description !== "string" ||
      cmd.description.trim().length === 0
    ) {
      return reject(
        `plugin_commands[${i}].description must be a non-empty string (V-05)`,
      );
    }

    // name 格式（Discord constraint）
    if (!cmd.name || !COMMAND_NAME_RE.test(cmd.name)) {
      return reject(
        `plugin_commands[${i}].name "${String(cmd.name)}" invalid ` +
          `(Discord constraint: ^[a-z0-9][a-z0-9-]{0,31}$)`,
      );
    }
    if (seenPluginCommandNames.has(cmd.name)) {
      return reject(
        `plugin_commands[${i}].name "${cmd.name}" is declared more than once`,
      );
    }
    seenPluginCommandNames.add(cmd.name);

    // V-06：scope
    if (cmd.scope !== "guild" && cmd.scope !== "global") {
      return reject(
        `plugin_commands[${cmd.name}].scope must be "guild" or "global" (V-06)`,
      );
    }

    // V-07：integration_types 必須是合法子集且非空
    if (
      !Array.isArray(cmd.integration_types) ||
      cmd.integration_types.length === 0
    ) {
      return reject(
        `plugin_commands[${cmd.name}].integration_types must be a non-empty array (V-07)`,
      );
    }
    for (const it of cmd.integration_types) {
      if (typeof it !== "string" || !VALID_INTEGRATION_TYPES.has(it)) {
        return reject(
          `plugin_commands[${cmd.name}].integration_types contains invalid value "${String(it)}" (V-07)`,
        );
      }
    }

    // V-08：contexts 必須是非空子集
    if (!Array.isArray(cmd.contexts) || cmd.contexts.length === 0) {
      return reject(
        `plugin_commands[${cmd.name}].contexts must be a non-empty array (V-08)`,
      );
    }
    for (const ctx of cmd.contexts) {
      if (typeof ctx !== "string" || !VALID_CONTEXTS.has(ctx)) {
        return reject(
          `plugin_commands[${cmd.name}].contexts contains invalid value "${String(ctx)}" (V-08)`,
        );
      }
    }

    const integrationTypesSet = new Set<string>(cmd.integration_types);
    const contextsSet = new Set<string>(cmd.contexts);
    const hasDmContext =
      contextsSet.has("BotDM") || contextsSet.has("PrivateChannel");

    // V-C1：scope="guild" 時，contexts 不能包含 BotDM 或 PrivateChannel
    if (cmd.scope === "guild" && hasDmContext) {
      return reject(
        `plugin_commands[${cmd.name}]: scope="guild" is incompatible with BotDM/PrivateChannel contexts (V-C1)`,
      );
    }

    // V-C2：scope="guild" 時，integration_types 不能包含 user_install
    if (cmd.scope === "guild" && integrationTypesSet.has("user_install")) {
      return reject(
        `plugin_commands[${cmd.name}]: scope="guild" is incompatible with user_install (V-C2)`,
      );
    }

    // V-C3：scope="global" 且 integration_types 不含 user_install 時，
    //       contexts 不能包含 BotDM 或 PrivateChannel
    if (
      cmd.scope === "global" &&
      !integrationTypesSet.has("user_install") &&
      hasDmContext
    ) {
      return reject(
        `plugin_commands[${cmd.name}]: scope="global" with guild_install-only cannot have BotDM/PrivateChannel contexts (V-C3)`,
      );
    }
  }

  // ── guild_features[] 驗證（沿用 v1 邏輯）──────────────────────────────
  // guild_features 的 commands[] 格式沿用 ManifestCommand（v1 相容）。
  // 命令名在整份 manifest 內唯一，所以 seen set 跨 feature 累積，也不能
  // 和 plugin_commands 同名：軌三 scope=global 涵蓋每個伺服器、scope=guild
  // 逐伺服器註冊，都與 feature 指令的 guild:<id> 重疊，Discord 同一個註冊
  // 目標只會留一個同名指令。
  const guildFeatures =
    (m.guild_features as ManifestGuildFeature[] | undefined) ?? [];
  const seenFeatureCommandNames = new Set<string>();
  const validateFeatureCommand = (
    c: ManifestCommand,
    origin: string,
  ): { ok: false; error: string } | null => {
    if (!c.name || !c.description) {
      return reject(`${origin}: name + description required`);
    }
    if (!COMMAND_NAME_RE.test(c.name)) {
      return reject(
        `${origin}: command.name '${c.name}' invalid (Discord constraint: ^[a-z0-9][a-z0-9-]{0,31}$)`,
      );
    }
    if (seenPluginCommandNames.has(c.name)) {
      return reject(
        `${origin}: command.name '${c.name}' is also declared in plugin_commands`,
      );
    }
    if (seenFeatureCommandNames.has(c.name)) {
      return reject(
        `${origin}: command.name '${c.name}' is declared more than once in the manifest`,
      );
    }
    seenFeatureCommandNames.add(c.name);
    return null;
  };

  for (const f of guildFeatures) {
    if (!f.key || !f.name) {
      return reject("every guild_feature requires key + name");
    }
    for (const c of f.commands ?? []) {
      const failed = validateFeatureCommand(
        c,
        `guild_features[${f.key}].commands`,
      );
      if (failed) return failed;
    }
  }

  // ── config_schema 宣告驗證 ───────────────────────────────────────────
  // Reject manifests with malformed defaults / invalid regex / inverted
  // ranges so the bug surfaces at plugin startup instead of after an
  // admin opens the config editor and gets an unhelpful save error.
  if (Array.isArray(m.config_schema)) {
    const failed = validateConfigSchema(m.config_schema as ManifestConfigField[]);
    if (failed) {
      return reject(`config_schema[${failed.key}]: ${failed.message}`);
    }
  }
  for (const f of guildFeatures) {
    if (Array.isArray(f.config_schema)) {
      const failed = validateConfigSchema(f.config_schema);
      if (failed) {
        return reject(
          `guild_features[${f.key}].config_schema[${failed.key}]: ${failed.message}`,
        );
      }
    }
  }

  // ── web_ui 驗證 ──────────────────────────────────────────────────────
  // Optional manage-WebUI declaration. manage_path becomes part of a URL
  // the admin UI opens, so constrain it: must be a rooted path with safe
  // chars, no trailing slash, no traversal.
  if (m.web_ui !== undefined && m.web_ui !== null) {
    if (typeof m.web_ui !== "object" || Array.isArray(m.web_ui)) {
      return reject("manifest.web_ui must be an object");
    }
    const mp = (m.web_ui as { manage_path?: unknown }).manage_path;
    if (mp !== undefined) {
      if (
        typeof mp !== "string" ||
        !/^\/[A-Za-z0-9/_-]*$/.test(mp) ||
        mp.endsWith("/") ||
        mp.includes("//") ||
        mp.includes("..")
      ) {
        return reject(
          `manifest.web_ui.manage_path "${String(mp)}" invalid — must start with "/", contain only [A-Za-z0-9/_-], and have no trailing slash`,
        );
      }
    }
  }

  return { ok: true, manifest: input as PluginManifest };
}

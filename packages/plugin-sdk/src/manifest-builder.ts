import type {
  ManifestCapability,
  ManifestCommand,
  ManifestGuildFeature,
  ManifestPluginCommand,
  PluginManifest,
} from "./manifest.js";
import type {
  GuildFeatureDefinition,
  PluginCapabilityDefinition,
  PluginCommandDefinition,
  PluginConfig,
} from "./plugin.js";

/**
 * True iff any of the plugin's commands (top-level or guild-feature) declares
 * an `autocomplete` handler. Used to decide whether to emit
 * `endpoints.plugin_autocomplete` in the manifest.
 */
function hasAutocompleteHandler(cfg: PluginConfig): boolean {
  if ((cfg.pluginCommands ?? []).some((c) => typeof c.autocomplete === "function")) {
    return true;
  }
  for (const f of cfg.guildFeatures ?? []) {
    if ((f.commands ?? []).some((c) => typeof c.autocomplete === "function")) {
      return true;
    }
  }
  return false;
}

/**
 * True iff the plugin declares any lifecycle hooks the SDK needs to
 * dispatch (`onEnable` / `onDisable`). When set, manifest carries an
 * `endpoints.plugin_lifecycle` field the bot uses to POST synthetic
 * `plugin.guild.enabled` / `plugin.guild.disabled` events on a path
 * separate from `endpoints.events` (so plugins that own their own
 * `/events` route — e.g. xiangqi — don't collide).
 */
function hasLifecycleHooks(cfg: PluginConfig): boolean {
  return (
    typeof cfg.onEnable === "function" || typeof cfg.onDisable === "function"
  );
}

/**
 * True iff the plugin opts into the modal flow in any way — by
 * declaring at least one modal handler or at least one command with
 * `responseKind: "modal"`. Either implies `ctx.sendModal()` will be
 * called against the bot's `interactions.send_modal` RPC, so the
 * scope must be in the token's set.
 */
function hasModalUse(cfg: PluginConfig): boolean {
  if ((cfg.modals ?? []).length > 0) return true;
  if ((cfg.pluginCommands ?? []).some((c) => c.responseKind === "modal")) {
    return true;
  }
  for (const f of cfg.guildFeatures ?? []) {
    if ((f.commands ?? []).some((c) => c.responseKind === "modal")) {
      return true;
    }
  }
  return false;
}

/**
 * 將 PluginConfig + pluginUrl 轉成 PluginManifest，提供給 startPluginClient
 * 註冊用。Plugin 作者不需要手動呼叫此函式（definePlugin.start() 內部會叫）。
 */
export function buildManifest(
  cfg: PluginConfig,
  pluginUrl: string,
): PluginManifest {
  const plugin_commands: ManifestPluginCommand[] = (
    cfg.pluginCommands ?? []
  ).map(
    (cmd: PluginCommandDefinition): ManifestPluginCommand => ({
      name: cmd.name,
      description: cmd.description,
      scope: cmd.scope,
      integration_types: cmd.integrationTypes,
      contexts: cmd.contexts,
      ...(cmd.options ? { options: cmd.options } : {}),
      ...(cmd.defaultMemberPermissions
        ? { default_member_permissions: cmd.defaultMemberPermissions }
        : {}),
      ...(cmd.defaultEphemeral !== undefined
        ? { default_ephemeral: cmd.defaultEphemeral }
        : {}),
      ...(cmd.requiredCapability
        ? { required_capability: cmd.requiredCapability }
        : {}),
      ...(cmd.responseKind ? { response_kind: cmd.responseKind } : {}),
    }),
  );

  const capabilities: ManifestCapability[] = (cfg.capabilities ?? []).map(
    (c: PluginCapabilityDefinition): ManifestCapability => ({
      key: c.key,
      description: c.description,
    }),
  );
  if (capabilities.length > 32) {
    throw new Error(
      `buildManifest: at most 32 capabilities allowed (got ${capabilities.length})`,
    );
  }
  const seenCapKeys = new Set<string>();
  for (const c of capabilities) {
    if (seenCapKeys.has(c.key)) {
      throw new Error(
        `buildManifest: capability key '${c.key}' is declared more than once`,
      );
    }
    seenCapKeys.add(c.key);
  }

  const guild_features: ManifestGuildFeature[] = (cfg.guildFeatures ?? []).map(
    (f: GuildFeatureDefinition): ManifestGuildFeature => ({
      key: f.key,
      name: f.name,
      ...(f.icon ? { icon: f.icon } : {}),
      ...(f.description ? { description: f.description } : {}),
      ...(f.enabledByDefault !== undefined
        ? { enabled_by_default: f.enabledByDefault }
        : {}),
      ...(f.eventsSubscribed ? { events_subscribed: f.eventsSubscribed } : {}),
      ...(f.configSchema ? { config_schema: f.configSchema } : {}),
      ...(f.surfaces ? { surfaces: f.surfaces } : {}),
      ...(f.overviewMetrics ? { overview_metrics: f.overviewMetrics } : {}),
      ...(f.commands && f.commands.length > 0
        ? {
            commands: f.commands.map(
              (cmd): ManifestCommand => ({
                name: cmd.name,
                description: cmd.description,
                scope: cmd.scope,
                integration_types: cmd.integrationTypes,
                contexts: cmd.contexts,
                ...(cmd.options ? { options: cmd.options } : {}),
                ...(cmd.defaultMemberPermissions
                  ? { default_member_permissions: cmd.defaultMemberPermissions }
                  : {}),
                ...(cmd.defaultEphemeral !== undefined
                  ? { default_ephemeral: cmd.defaultEphemeral }
                  : {}),
                ...(cmd.requiredCapability
                  ? { required_capability: cmd.requiredCapability }
                  : {}),
                ...(cmd.responseKind
                  ? { response_kind: cmd.responseKind }
                  : {}),
              }),
            ),
          }
        : {}),
    }),
  );

  const manifest: PluginManifest = {
    schema_version: "1",
    plugin: {
      id: cfg.key,
      name: cfg.name,
      version: cfg.version,
      ...(cfg.description ? { description: cfg.description } : {}),
      ...(cfg.author ? { author: cfg.author } : {}),
      ...(cfg.homepage ? { homepage: cfg.homepage } : {}),
      url: pluginUrl,
      healthcheck_path: "/health",
    },
    // Auto-inject scopes that are implied by other declarations so
    // plugin authors can't forget them. Today: declaring `modals`
    // implies the SDK will call `interactions.send_modal` via
    // `ctx.sendModal`, and a command with `responseKind: "modal"`
    // implies the same. Without this, plugin authors saw a generic
    // 403 "plugin token missing scope 'interactions.send_modal'"
    // with no hint that the manifest opt-in was the missing piece.
    ...(((): { rpc_methods_used?: string[] } => {
      const scopes = new Set<string>(cfg.rpcMethodsUsed ?? []);
      if (hasModalUse(cfg)) scopes.add("interactions.send_modal");
      return scopes.size > 0
        ? { rpc_methods_used: [...scopes] }
        : {};
    })()),
    ...(cfg.storage
      ? {
          storage: {
            guild_kv: cfg.storage.guildKv,
            guild_kv_quota_kb: cfg.storage.guildKvQuotaKb,
            requires_secrets: cfg.storage.requiresSecrets,
          },
        }
      : {}),
    ...(cfg.configSchema ? { config_schema: cfg.configSchema } : {}),
    ...(guild_features.length > 0 ? { guild_features } : {}),
    ...(plugin_commands.length > 0 ? { plugin_commands } : {}),
    ...(capabilities.length > 0 ? { capabilities } : {}),
    endpoints: {
      plugin_command: "/commands/{command_name}",
      // Always present — SDK mounts /health/detail unconditionally so
      // the bot can poll a uniform shape regardless of whether the
      // plugin author registered a custom HealthProducer.
      health: "/health/detail",
      // Separate from `events`: the bot POSTs synthetic
      // `plugin.guild.enabled` / `plugin.guild.disabled` events here
      // so plugins owning their own `/events` route don't collide.
      // Only declared when at least one lifecycle hook is set.
      ...(hasLifecycleHooks(cfg)
        ? { plugin_lifecycle: "/_kc/lifecycle" }
        : {}),
      ...((cfg.components ?? []).length > 0
        ? { plugin_component: "/components" }
        : {}),
      ...((cfg.modals ?? []).length > 0
        ? { plugin_modal: "/modals/{modal_id}" }
        : {}),
      // Emit autocomplete endpoint when at least one command declares
      // an autocomplete handler. We use the SDK builder-side
      // `autocomplete` field as the signal, not the per-option
      // `autocomplete: true` flag — the bot only routes if there's
      // a handler waiting.
      ...(hasAutocompleteHandler(cfg)
        ? { plugin_autocomplete: "/commands/{command_name}/autocomplete" }
        : {}),
    },
  };

  return manifest;
}

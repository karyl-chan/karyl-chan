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
import type { CommandOption, CommandOptionTypeName } from "./types.js";
import { isCanonicalEvent } from "./events.js";
import { createRequire } from "node:module";

/**
 * Discord's numeric `ApplicationCommandOptionType` enum mapped to the
 * snake_case string form the manifest carries on the wire. Plugin
 * authors writing `type: ApplicationCommandOptionType.String` get
 * compile-time safety; the wire form stays the existing string union
 * so the bot's relayer doesn't have to learn two encodings.
 */
const OPTION_TYPE_NUM_TO_STRING: Record<number, CommandOptionTypeName> = {
  1: "sub_command",
  2: "sub_command_group",
  3: "string",
  4: "integer",
  5: "boolean",
  6: "user",
  7: "channel",
  8: "role",
  9: "mentionable",
  10: "number",
  11: "attachment",
};

function normalizeOptionType(
  type: CommandOption["type"],
): CommandOptionTypeName {
  if (typeof type === "string") return type;
  const mapped = OPTION_TYPE_NUM_TO_STRING[type];
  if (!mapped) {
    throw new Error(
      `buildManifest: unknown numeric ApplicationCommandOptionType '${type}'`,
    );
  }
  return mapped;
}

/**
 * Plugin authors writing options may use either snake_case
 * (`description_localizations`, the SDK type field) or camelCase
 * (`descriptionLocalizations`, what discord.js itself uses elsewhere
 * — a tempting copy-paste from raw Discord docs). Normalise both into
 * the snake_case wire form so the bot's relayer sees a consistent
 * shape regardless of which form the plugin wrote.
 *
 * Also coerces numeric `type` values (from `ApplicationCommandOptionType`)
 * to the wire-form string so the bot sees one encoding.
 */
function normalizeOption(
  o: CommandOption & {
    descriptionLocalizations?: Record<string, string>;
    nameLocalizations?: Record<string, string>;
  },
): CommandOption {
  const descLoc = o.description_localizations ?? o.descriptionLocalizations;
  const nameLoc = o.name_localizations ?? o.nameLocalizations;
  const { descriptionLocalizations, nameLocalizations, ...rest } = o;
  void descriptionLocalizations;
  void nameLocalizations;
  return {
    ...rest,
    type: normalizeOptionType(o.type),
    ...(descLoc ? { description_localizations: descLoc } : {}),
    ...(nameLoc ? { name_localizations: nameLoc } : {}),
    ...(o.options ? { options: o.options.map(normalizeOption) } : {}),
  };
}

// Pulled in so `buildManifest` can stamp the SDK version onto every
// manifest. Bot reads this for per-version compat shims. We use
// `createRequire` (not a JSON import) so tsc's rootDir stays under
// `src/` — a top-level JSON import would pull the package.json into
// the compile root and reshape dist/ to `dist/src/index.js`, breaking
// the published `main` path.
const pkg = createRequire(import.meta.url)("../package.json") as {
  version: string;
};
const SDK_VERSION: string = pkg.version;

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
 * `plugin.guild.enabled` / `plugin.guild.disabled` events on its own
 * path — `/_kc/lifecycle` — distinct from Discord-side event dispatch
 * at `/events` so the two routes never collide.
 */
function hasLifecycleHooks(cfg: PluginConfig): boolean {
  return (
    typeof cfg.onEnable === "function" || typeof cfg.onDisable === "function"
  );
}

/**
 * Collect every Discord-side event type the plugin has a handler
 * for. Used to auto-fill `events_subscribed_global` so plugin
 * authors don't have to keep a parallel list in sync with their
 * `eventHandlers` object — the keys ARE the subscription set.
 */
function collectEventHandlerKeys(cfg: PluginConfig): string[] {
  if (!cfg.eventHandlers || typeof cfg.eventHandlers !== "object") return [];
  return Object.keys(cfg.eventHandlers).filter(
    (k) => typeof k === "string" && k.length > 0,
  );
}

function hasAnyEventHandler(cfg: PluginConfig): boolean {
  return collectEventHandlerKeys(cfg).length > 0;
}

/**
 * True iff the plugin opts into the modal flow in any way — by
 * declaring at least one modal handler or at least one command with
 * `modal: true`. Either implies `ctx.sendModal()` will be called
 * against the bot's `interactions.send_modal` RPC, so the scope must
 * be in the token's set.
 */
function hasModalUse(cfg: PluginConfig): boolean {
  if ((cfg.modals ?? []).length > 0) return true;
  if ((cfg.pluginCommands ?? []).some((c) => c.modal)) {
    return true;
  }
  for (const f of cfg.guildFeatures ?? []) {
    if ((f.commands ?? []).some((c) => c.modal)) {
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
      ...(cmd.options ? { options: cmd.options.map(normalizeOption) } : {}),
      ...(cmd.descriptionLocalizations
        ? { description_localizations: cmd.descriptionLocalizations }
        : {}),
      ...(cmd.nameLocalizations
        ? { name_localizations: cmd.nameLocalizations }
        : {}),
      ...(cmd.defaultMemberPermissions
        ? { default_member_permissions: cmd.defaultMemberPermissions }
        : {}),
      ...(cmd.defaultEphemeral !== undefined
        ? { default_ephemeral: cmd.defaultEphemeral }
        : {}),
      ...(cmd.requiredCapability
        ? { required_capability: cmd.requiredCapability }
        : {}),
      ...(cmd.modal !== undefined ? { modal: cmd.modal } : {}),
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
      ...(f.commands && f.commands.length > 0
        ? {
            commands: f.commands.map(
              (cmd): ManifestCommand => ({
                name: cmd.name,
                description: cmd.description,
                scope: cmd.scope,
                integration_types: cmd.integrationTypes,
                contexts: cmd.contexts,
                ...(cmd.options ? { options: cmd.options.map(normalizeOption) } : {}),
                ...(cmd.descriptionLocalizations
                  ? { description_localizations: cmd.descriptionLocalizations }
                  : {}),
                ...(cmd.nameLocalizations
                  ? { name_localizations: cmd.nameLocalizations }
                  : {}),
                ...(cmd.defaultMemberPermissions
                  ? { default_member_permissions: cmd.defaultMemberPermissions }
                  : {}),
                ...(cmd.defaultEphemeral !== undefined
                  ? { default_ephemeral: cmd.defaultEphemeral }
                  : {}),
                ...(cmd.requiredCapability
                  ? { required_capability: cmd.requiredCapability }
                  : {}),
                ...(cmd.modal !== undefined ? { modal: cmd.modal } : {}),
              }),
            ),
          }
        : {}),
    }),
  );

  const manifest: PluginManifest = {
    sdk_version: SDK_VERSION,
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
    // plugin authors can't forget them. Each rule maps a declarative
    // signal (something already in the config) to the scopes the SDK
    // will inevitably call. Without these auto-adds, plugin authors
    // who switched from `botRpc(path, …)` to a typed facade would hit
    // 403 from `requireScope` on the bot side with no diagnostic
    // pointing back at the manifest as the fix.
    //
    //   - any plugin / guild-feature command, component, or modal
    //     handler ⇒ `interactions.respond` (the SDK uses this to
    //     fill in the deferred reply after every dispatch)
    //   - any component handler that opts into a follow-up
    //     (and SDK's component error-recovery path) ⇒
    //     `interactions.followup`
    //   - `modals` / `modal:true` ⇒ `interactions.send_modal`
    //   - `storage.guildKv: true` ⇒ full KV scope set + `me.kv_usage`
    //   - presence of `onStart` / `onStop` (signals a background
    //     worker) ⇒ `me.enabled_guilds` so cross-guild loops work
    //   - SDK observability surface ⇒ `me.log` + `me.metrics`
    //
    // Explicit `rpcMethodsUsed` entries are still merged in — they
    // remain the documented escape hatch for any scope the auto-rules
    // don't cover (e.g. `voice.*` / `channels.*` / `roles.*` /
    // `members.add_role`).
    ...(((): { rpc_methods_used?: string[] } => {
      const scopes = new Set<string>(cfg.rpcMethodsUsed ?? []);
      const hasAnyCommand =
        (cfg.pluginCommands ?? []).length > 0 ||
        (cfg.guildFeatures ?? []).some(
          (f) => (f.commands ?? []).length > 0,
        );
      const hasAnyComponent = (cfg.components ?? []).length > 0;
      const hasAnyHandler = hasAnyCommand || hasAnyComponent || hasModalUse(cfg);
      if (hasAnyHandler) {
        scopes.add("interactions.respond");
      }
      if (hasAnyComponent || hasAnyCommand) {
        // Component error-recovery in server.ts uses followup;
        // command authors frequently use it too for multi-step
        // replies. Adding both keeps either path warning-free.
        scopes.add("interactions.followup");
      }
      if (hasModalUse(cfg)) scopes.add("interactions.send_modal");
      if (cfg.storage?.guildKv) {
        scopes.add("storage.kv_get");
        scopes.add("storage.kv_set");
        scopes.add("storage.kv_list");
        scopes.add("storage.kv_list_values");
        scopes.add("storage.kv_delete");
        scopes.add("storage.kv_increment");
        scopes.add("me.kv_usage");
      }
      if (
        typeof cfg.onStart === "function" ||
        typeof cfg.onStop === "function"
      ) {
        scopes.add("me.enabled_guilds");
      }
      scopes.add("me.log");
      scopes.add("me.metrics");
      return scopes.size > 0
        ? { rpc_methods_used: [...scopes].sort() }
        : {};
    })()),
    ...(cfg.storage
      ? {
          storage: {
            guildKv: cfg.storage.guildKv,
            guildKvQuotaKb: cfg.storage.guildKvQuotaKb,
            requiresSecrets: cfg.storage.requiresSecrets,
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
      // Discord-side events. SDK mounts /events only when at least
      // one `eventHandlers` entry is declared; without handlers the
      // route is absent and the bot's `resolveEventsUrl` falls back
      // to the default but the dispatch returns 404 (which the bot
      // surfaces in its event log so the misconfig is visible).
      ...(hasAnyEventHandler(cfg) ? { events: "/events" } : {}),
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

  // Merge `eventHandlers` keys into `events_subscribed_global` so the
  // bot's event-index rebuild picks up the subscription set without
  // the author having to keep two lists in sync. Feature-scoped
  // subscriptions on guildFeatures[].eventsSubscribed still flow
  // through the feature path (admin-UI visibility), so this merge
  // is set-union, not replace.
  const handlerKeys = collectEventHandlerKeys(cfg);
  if (handlerKeys.length > 0) {
    const existing = new Set<string>(manifest.events_subscribed_global ?? []);
    for (const k of handlerKeys) existing.add(k);
    manifest.events_subscribed_global = [...existing];
  }

  // Build-time canonical-event check. The bot dispatches a small set
  // of `<surface>.<verb>` event names (see `events.ts`); subscribing
  // to anything else (e.g. raw `MESSAGE_CREATE`) is a dead handler.
  // Warn loudly so the bug surfaces at build / startup, not via
  // "why isn't my handler firing?" three releases later.
  const subscribedAll = new Set<string>([
    ...(manifest.events_subscribed_global ?? []),
    ...(manifest.guild_features ?? []).flatMap(
      (f) => f.events_subscribed ?? [],
    ),
  ]);
  const dead = [...subscribedAll].filter((e) => !isCanonicalEvent(e));
  if (dead.length > 0) {
    // eslint-disable-next-line no-console
    console.warn(
      `[plugin-sdk] manifest subscribes to non-canonical event(s): ${dead.join(", ")} — these will never fire. Use Events.* from @karyl-chan/plugin-sdk.`,
    );
  }

  return manifest;
}

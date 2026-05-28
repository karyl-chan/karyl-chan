export {
  definePlugin,
  definePluginCommand,
  defineGuildFeature,
  definePluginCapability,
  definePluginComponent,
  definePluginModal,
  componentCustomId,
  modalCustomId,
} from "./plugin.js";
export type {
  PluginConfig,
  PluginCommandDefinition,
  GuildFeatureDefinition,
  PluginCapabilityDefinition,
  PluginComponentDefinition,
  PluginModalDefinition,
  PluginInstance,
  StartedPlugin,
  StartOptions,
  EventHandler,
} from "./plugin.js";

export type {
  PluginManifest,
  ManifestPluginCommand,
  ManifestCapability,
  ManifestGuildFeature,
  ManifestConfigField,
  ManifestCommandOption,
  ManifestCommand,
} from "./manifest.js";

export type {
  AutocompleteContext,
  CommandContext,
  CommandReply,
  CommandOption,
  CommandOptionTypeName,
  ComponentContext,
  ComponentReply,
  InteractionContext,
  Logger,
  MessageActionRow,
  MessageAttachment,
  ModalActionRow,
  ModalContext,
  ModalData,
  ModalReply,
  WebhookPayload,
  // Typed RPC facade
  Discord,
  Voice,
  // discord-api-types primitives re-exported for plugin authors
  APIApplicationCommandOptionChoice,
  APIEmbed,
  APIActionRowComponent,
  APIComponentInMessageActionRow,
  APIComponentInModalActionRow,
  APIModalInteractionResponseCallbackData,
  MessageFlags,
} from "./types.js";

// Typed RPC argument / return shapes — exported so plugin code can
// type intermediate helpers (`function fooBar(): Promise<VoiceStatus>`).
export type {
  DiscordMessages,
  DiscordMembers,
  DiscordInteractions,
  MessageSendArgs,
  MessageEditArgs,
  MessageDeleteArgs,
  MessageAddReactionArgs,
  MessageHandle,
  MemberGetArgs,
  MemberSummary,
  InteractionRespondArgs,
  InteractionFollowupArgs,
  VoiceJoinArgs,
  VoicePlayArgs,
  VoicePauseArgs,
  VoiceStatus,
  Me,
  MeKvUsageArgs,
  MeKvUsage,
  Kv,
  GuildKv,
  KvListOptions,
  KvEntry,
  KvSetResult,
  KvIncrementResult,
  Auth,
  SessionKind,
  MintSessionArgs,
  MintSessionResult,
  PluginRpc,
  RpcCaller,
} from "./rpc/index.js";

// Hard caps the typed KV facade pre-checks before round-tripping the bot.
export { KV_KEY_MAX, KV_VALUE_MAX_BYTES } from "./rpc/index.js";

// Re-export common Discord enum values so plugins can avoid magic
// numbers in option / component / button declarations. These mirror
// the public `discord-api-types` surface byte-for-byte.
export {
  ApplicationCommandOptionType,
  ApplicationCommandType,
  ComponentType,
  ButtonStyle,
  TextInputStyle,
  ChannelType,
  InteractionContextType,
} from "discord-api-types/v10";

/**
 * Factory for the typed RPC facade — exposed so test helpers and
 * alternative runtime wrappers can build a `Discord` / `Voice`
 * namespace from an arbitrary `RpcCaller` (e.g. a vi.fn() stub that
 * records calls).
 */
export { createPluginRpc } from "./rpc/index.js";

export { verifyWebhookToken } from "./webhook-token.js";

// Bot RPC error class — plugins discriminating on RPC failure catch
// this and inspect `reason`. Reasons are unioned in `BotRpcErrorReason`.
export { BotRpcError } from "./server.js";
export type { BotRpcErrorReason } from "./server.js";

export {
  verifyPluginSession,
  hasPluginCapability,
} from "./verify-plugin-session.js";
export type { PluginSessionClaims } from "./verify-plugin-session.js";

// Lifecycle + observability types.
export type {
  PluginContext,
  PluginLogger,
  PluginBotEventLog,
  PluginBotEventEntry,
  PluginMetrics,
  MetricsCounter,
  MetricsGauge,
  MetricsHistogram,
  HealthReport,
  HealthCheckEntry,
  HealthStatus,
  HealthProducer,
} from "./context.js";

// HMAC primitives — used by plugins that mount their own dispatch-style
// routes (e.g. a custom webhook receiver). The SDK already verifies its
// built-in `/commands` + `/components` + `/modals` + `/events` +
// `/commands/:name/autocomplete`; anything else the plugin opens up
// against bot-dispatched POSTs must verify these headers itself.
// `dispatchHmacKey` comes from `StartedPlugin.getDispatchHmacKey()`.
//
// `verifyDispatchHmac` is the one-call helper plugins should use to
// validate an inbound POST; `sign` / `verify` / `isFreshTimestamp` are
// the primitives it wraps for advanced cases.
export {
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  sign,
  verify,
  isFreshTimestamp,
  verifyDispatchHmac,
} from "./hmac.js";

// Canonical event type names. Use these as keys in `eventHandlers`.
export { Events, isCanonicalEvent } from "./events.js";
export type { EventName } from "./events.js";

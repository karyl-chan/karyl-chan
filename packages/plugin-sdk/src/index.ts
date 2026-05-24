export {
  definePlugin,
  definePluginCommand,
  defineGuildFeature,
  definePluginCapability,
  definePluginComponent,
  componentCustomId,
} from "./plugin.js";
export type {
  PluginConfig,
  PluginCommandDefinition,
  GuildFeatureDefinition,
  PluginCapabilityDefinition,
  PluginComponentDefinition,
  PluginInstance,
  StartedPlugin,
  StartOptions,
} from "./plugin.js";

export type {
  PluginManifest,
  ManifestPluginCommand,
  ManifestCapability,
  ManifestGuildFeature,
  ManifestConfigField,
  ManifestCommandOption,
} from "./manifest.js";

export type {
  CommandContext,
  CommandReply,
  CommandOption,
  InteractionContext,
  Logger,
  MessageAttachment,
  WebhookPayload,
  ComponentContext,
  ComponentReply,
} from "./types.js";

export { verifyWebhookToken } from "./webhook-token.js";

export {
  verifyPluginSession,
  hasPluginCapability,
} from "./verify-plugin-session.js";
export type { PluginSessionClaims } from "./verify-plugin-session.js";

// HMAC primitives — used by plugins that mount their own dispatch-style
// routes (e.g. `/events` for `guild.message_create`). The SDK already
// verifies its built-in `/commands` + `/components`; anything else the
// plugin opens up against bot-dispatched POSTs must verify these headers
// itself. `dispatchHmacKey` comes from `StartedPlugin.getDispatchHmacKey()`.
export {
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  sign,
  verify,
  isFreshTimestamp,
} from "./hmac.js";

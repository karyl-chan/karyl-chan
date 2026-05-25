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
  // discord-api-types primitives re-exported for plugin authors
  APIApplicationCommandOptionChoice,
  APIEmbed,
  APIActionRowComponent,
  APIComponentInMessageActionRow,
  APIComponentInModalActionRow,
  APIModalInteractionResponseCallbackData,
  MessageFlags,
} from "./types.js";

export { verifyWebhookToken } from "./webhook-token.js";

export {
  verifyPluginSession,
  hasPluginCapability,
} from "./verify-plugin-session.js";
export type { PluginSessionClaims } from "./verify-plugin-session.js";

// HMAC primitives — used by plugins that mount their own dispatch-style
// routes (e.g. `/events` for `guild.message_create`). The SDK already
// verifies its built-in `/commands` + `/components` + `/modals` +
// `/commands/:name/autocomplete`; anything else the plugin opens up
// against bot-dispatched POSTs must verify these headers itself.
// `dispatchHmacKey` comes from `StartedPlugin.getDispatchHmacKey()`.
export {
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  sign,
  verify,
  isFreshTimestamp,
} from "./hmac.js";

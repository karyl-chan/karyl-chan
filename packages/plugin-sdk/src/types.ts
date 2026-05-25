import type {
  APIApplicationCommandOptionChoice,
  APIEmbed,
  APIActionRowComponent,
  APIComponentInMessageActionRow,
  APIComponentInModalActionRow,
  APIModalInteractionResponseCallbackData,
  MessageFlags,
  RESTPostAPIWebhookWithTokenJSONBody,
} from "discord-api-types/v10";

/**
 * `components` array on a message-level reply (a Discord action row
 * whose children are buttons + select menus).
 *
 * Aliased here so plugin authors get a stable, short name even when
 * discord-api-types renames the underlying type (it has shifted from
 * `APIMessageActionRowComponent` to `APIComponentInMessageActionRow`
 * between releases).
 */
export type MessageActionRow = APIActionRowComponent<APIComponentInMessageActionRow>;
/** `components` array inside a modal (action row of text inputs). */
export type ModalActionRow = APIActionRowComponent<APIComponentInModalActionRow>;
/** Modal definition shape — handed to `interactions.send_modal`. */
export type ModalData = APIModalInteractionResponseCallbackData;

/** Re-exports of the discord-api-types primitives plugin authors touch most. */
export type {
  APIApplicationCommandOptionChoice,
  APIEmbed,
  APIActionRowComponent,
  APIComponentInMessageActionRow,
  APIComponentInModalActionRow,
  APIModalInteractionResponseCallbackData,
  MessageFlags,
};

/** Minimal logger interface — matches Fastify's log shape for the fields we use. */
export interface Logger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

/**
 * Context passed to every command handler.
 * Gateway-agnostic: Discord-specific fields are exposed directly for now;
 * a future gateway abstraction layer will wrap these.
 */
export interface CommandContext {
  /** Plugin key (= manifest.plugin.id) */
  pluginKey: string;
  /** Slash command name */
  commandName: string;
  /** Sub-command name (null if not used) */
  subCommandName: string | null;
  /** Parsed options as { name: value } map */
  options: Record<string, unknown>;
  /** Guild ID the command was invoked in; null for DM / bot-DM contexts */
  guildId: string | null;
  /** Channel the command was invoked in; null if Discord didn't send it. */
  channelId: string | null;
  /** Discord user ID of the invoker */
  userId: string;
  /**
   * Human-readable display name of the invoker — the Discord *global*
   * display name when set, else the legacy username, else the user id as
   * a last resort. Use this for "queued by …" / audit text instead of
   * the raw id or a `<@id>` mention (mentions only render inside Discord
   * messages, not in a plugin's own WebUI). Falls back to the id when
   * talking to an older bot that doesn't send the name.
   */
  userDisplayName: string;
  /**
   * The invoker's plugin-relevant RBAC capabilities for THIS dispatch, as
   * the bot resolved them: the `admin` superuser token (if held) plus this
   * plugin's own `plugin:<pluginKey>:*` grants. Only populated when the
   * invocation has a guild member — empty in DM / user-install contexts
   * (and against an older bot). Prefer `hasCapability()` over inspecting
   * this directly.
   */
  capabilities: string[];
  /**
   * True if the invoker holds `plugin:<this plugin's key>:<capKey>`, or
   * `admin` (superuser bypass). For gating a subcommand on a capability
   * the plugin declared via `definePluginCapability` —
   * `if (!ctx.hasCapability("download")) return "…"`.
   */
  hasCapability(capKey: string): boolean;
  /** Logger from the underlying Fastify instance */
  log: Logger;
  /**
   * Browser-reachable base URL the bot exposes for this plugin's HTTP
   * surface, i.e. `<bot>/plugin/<key>`. Only set after at least one
   * successful register and only when the bot has `WEB_BASE_URL`
   * configured; otherwise undefined.
   */
  publicBaseUrl?: string;
  /**
   * The Discord interaction id (snowflake) for this command invocation.
   * Combined with `interactionToken`, lets a plugin handler open a modal
   * via `interactions.send_modal` — the only response type that can't go
   * through the deferred `interactions.respond` flow. Most handlers will
   * not need this directly.
   */
  interactionId: string;
  /**
   * The interaction token for this command invocation. Required when
   * calling `interactions.send_modal`; the regular `interactions.respond`
   * /`followup` RPCs read the token from the bot's side via the
   * interaction id, so most handlers will not need this directly.
   */
  interactionToken: string;
  /**
   * Call a bot-side plugin RPC endpoint (e.g. `/api/plugin/voice.play`).
   * Authorization header and base URL are filled in automatically.
   * Returns the parsed JSON body on 2xx, an empty object on 204,
   * or null on network / non-2xx errors (already logged).
   *
   * The plugin manifest must declare any RPC method used here under
   * `rpcMethodsUsed` or the bot will mint a token without that scope.
   */
  botRpc(path: string, body?: unknown): Promise<unknown | null>;
  /**
   * Open a Discord modal as the response to this command. Wraps the
   * `interactions.send_modal` RPC with the interaction id/token already
   * filled in. Must be called within ~2.5 s of the dispatch — Discord
   * rejects modals once the interaction is older than 3 s.
   *
   * Returning a modal from a command handler bypasses the normal
   * deferred-reply flow: the command's own reply is the modal itself,
   * and any user follow-up arrives as a separate `MODAL_SUBMIT`
   * interaction with a fresh token. Wire the submit handler with
   * `definePluginModal({ id, handler })`.
   */
  sendModal(modal: ModalData): Promise<boolean>;
}

/**
 * A file the bot attaches to a message on the plugin's behalf.
 * `path` is a path on the plugin's own HTTP surface (e.g.
 * `/art/card.png`); the bot fetches `<plugin.url><path>` over the
 * internal bot↔plugin network and uploads the bytes to Discord as a
 * real attachment. An embed references it via
 * `image: { url: "attachment://<name>" }`.
 *
 * This lets a plugin embed images without exposing a
 * Discord-reachable public URL — useful for local-dev / tunnelless
 * deployments where the bot's WEB_BASE_URL isn't internet-routable.
 */
export interface MessageAttachment {
  /** Attachment filename — must match the `attachment://<name>` ref. */
  name: string;
  /** Leading-slash path on the plugin's HTTP surface. */
  path: string;
}

/**
 * What a command handler may return.
 *
 * A plain string is shorthand for `{ content: string }`. The structured
 * shape uses canonical discord-api-types primitives for `embeds`,
 * `components`, and `flags` — plugin code can build them via discord.js
 * `EmbedBuilder` / `ActionRowBuilder` or raw object literals, both work.
 *
 * `flags` accepts the `MessageFlags` enum (e.g. `MessageFlags.Ephemeral`,
 * `MessageFlags.SuppressEmbeds`). The convenience `ephemeral: true`
 * still works and gets OR'd into the flag set.
 */
export type CommandReply =
  | string
  | {
      content?: string;
      embeds?: APIEmbed[];
      components?: MessageActionRow[];
      ephemeral?: boolean;
      flags?: MessageFlags;
      attachments?: MessageAttachment[];
    };

/**
 * A single option definition attached to a command.
 *
 * Plugin-facing API uses string type names (`"string"`, `"integer"`,
 * …) for ergonomics; the manifest builder maps them to discord-api-types
 * numeric `ApplicationCommandOptionType` values when emitting the
 * manifest. New numeric-only fields (`autocomplete`, `min_value`,
 * `max_value`, `min_length`, `max_length`) come from discord-api-types
 * and only apply to the option types Discord actually supports them on
 * — we don't enforce that here; Discord rejects mis-applied fields at
 * registration time with a helpful error.
 */
export interface CommandOption {
  type:
    | "string"
    | "integer"
    | "boolean"
    | "number"
    | "channel"
    | "user"
    | "role"
    | "mentionable"
    | "attachment"
    | "sub_command"
    | "sub_command_group";
  name: string;
  description: string;
  required?: boolean;
  choices?: APIApplicationCommandOptionChoice[];
  /** Restrict channel option to specific channel types (e.g. "GUILD_TEXT"). */
  channel_types?: string[];
  /** For `sub_command` / `sub_command_group` — nested options. */
  options?: CommandOption[];
  /**
   * String / integer / number options can opt into autocomplete. When
   * true the bot dispatches AUTOCOMPLETE interactions to the plugin's
   * `definePluginCommand({ autocomplete: … })` handler.
   */
  autocomplete?: boolean;
  /** Numeric range constraints (integer / number options). */
  min_value?: number;
  max_value?: number;
  /** String length constraints (string options). */
  min_length?: number;
  max_length?: number;
}

/** Discord interaction context types. */
export type InteractionContext = "Guild" | "BotDM" | "PrivateChannel";

// ── v2 新增型別 ─────────────────────────────────────────────────────────────

/**
 * Discord webhook POST body shape — re-export of discord-api-types'
 * `RESTPostAPIWebhookWithTokenJSONBody` so plugin webhook routes
 * (webhook-source behaviors) can type the payload they parse without
 * a separate import.
 */
export type WebhookPayload = RESTPostAPIWebhookWithTokenJSONBody;

// ── Component（按鈕 + select menus）互動 ────────────────────────────────────

/**
 * Context passed to a plugin *component* (button or select-menu) handler.
 *
 * A component "owned" by a plugin has a `custom_id` of the form
 * `kc:<pluginKey>:<componentId>[:<tail>]` (`kc` = "karyl plugin
 * component"). On a click / submit the bot resolves the plugin,
 * `deferUpdate`s the interaction (acks without changing the message),
 * and POSTs the event here. Because component interactions create a
 * *fresh* interaction (and a fresh 15-minute token) on every event,
 * the handler isn't bound by the original message's age — it can keep
 * editing that message for as long as it exists.
 *
 * For select menus, `selectedValues` carries the user's selection (one
 * entry for single-select menus, multiple for `min_values`/`max_values`
 * multi-selects). User / role / mentionable / channel selects also
 * return the selected snowflakes here; the resolved entities are not
 * forwarded — fetch them separately if you need the names/colours.
 */
export interface ComponentContext {
  /** Plugin key (= manifest.plugin.id). */
  pluginKey: string;
  /** Full Discord custom_id, e.g. `kc:karyl-radio:next` or `kc:karyl-radio:replay:42`. */
  customId: string;
  /** The component id — the segment after `kc:<pluginKey>:`, before any `:tail`. */
  componentId: string;
  /** Everything after `kc:<pluginKey>:<componentId>:`, or `""` for ids that carry no args. */
  tail: string;
  /** Guild the component was interacted with; null for DM contexts. */
  guildId: string | null;
  /** Channel the component's message lives in; null if Discord didn't supply it. */
  channelId: string | null;
  /** Id of the message the component is attached to. */
  messageId: string;
  /**
   * Selected values for select-menu interactions. Empty array for
   * button interactions. For user/role/mentionable/channel selects the
   * values are the chosen snowflakes.
   */
  selectedValues: string[];
  /**
   * The (fresh, 15-min) interaction token for this event. The bot has
   * already `deferUpdate`d the interaction; pass this token to
   * `/api/plugin/interactions.followup` for an ephemeral nudge — e.g.
   * `ctx.botRpc("/api/plugin/interactions.followup", { interaction_token:
   * ctx.interactionToken, content, ephemeral: true })`. (Editing the
   * message is easier via the handler's return value.)
   */
  interactionToken: string;
  /** Discord user id of whoever clicked / submitted. */
  userId: string;
  /** Display name of the user — global display name → username → id. */
  userDisplayName: string;
  /**
   * The user's current voice-channel id in this guild, or null when
   * they aren't in voice (or this isn't a guild). Lets a plugin gate
   * controls on "you must be in the bot's voice channel".
   */
  voiceChannelId: string | null;
  /**
   * The user's plugin-relevant RBAC capabilities for THIS event, as
   * the bot resolved them: `admin` (if held) plus this plugin's own
   * `plugin:<pluginKey>:*` grants. Prefer `hasCapability()`.
   */
  capabilities: string[];
  /** True if the user holds `plugin:<this plugin's key>:<capKey>`, or `admin`. */
  hasCapability(capKey: string): boolean;
  /** Logger from the underlying Fastify instance. */
  log: Logger;
  /** Browser-reachable base URL for this plugin's HTTP surface, if the bot exposes one. */
  publicBaseUrl?: string;
  /**
   * Call a bot-side plugin RPC. The interaction was already `deferUpdate`d
   * by the bot, so use `/api/plugin/interactions.respond` to edit the
   * message the component is on (it PATCHes `@original`) — though
   * returning a `{ content?, embeds?, components? }` from the handler
   * does that for you — or `/api/plugin/interactions.followup` with
   * `{ ephemeral: true }` for a nudge that doesn't touch the message.
   */
  botRpc(path: string, body?: unknown): Promise<unknown | null>;
}

/**
 * What a component handler may return:
 *  - nothing / null / undefined → leave the message as-is (the bot has
 *    already acked the click with `deferUpdate`)
 *  - `{ content?, embeds?, components?, flags? }` → edit the message the
 *    component is on with these fields (forwarded to
 *    `interactions.respond`; omitted fields are left unchanged,
 *    `components: []` clears buttons/menus).
 *
 * For an ephemeral reply that doesn't touch the message use
 * `ctx.botRpc("/api/plugin/interactions.followup", { ephemeral: true, content })`.
 */
export type ComponentReply =
  | void
  | null
  | {
      content?: string;
      embeds?: APIEmbed[];
      components?: MessageActionRow[];
      flags?: MessageFlags;
    };

// ── Modal interactions ──────────────────────────────────────────────────────

/**
 * Context passed to a plugin *modal-submit* handler.
 *
 * A modal opened by a plugin has a `custom_id` of the form
 * `kc:<pluginKey>:<modalId>[:<tail>]`. When the user submits, the bot
 * `deferReply`s the resulting interaction (ephemeral by default) and
 * POSTs the form data here. The handler typically reads `fields` and
 * returns a reply that becomes the deferred response.
 */
export interface ModalContext {
  /** Plugin key. */
  pluginKey: string;
  /** Full custom_id of the modal, including any `:tail` arguments. */
  customId: string;
  /** Modal id — the segment after `kc:<pluginKey>:`, before any `:tail`. */
  modalId: string;
  /** Everything after `kc:<pluginKey>:<modalId>:`, or `""`. */
  tail: string;
  /** Submitted text-input values, keyed by each input's `custom_id`. */
  fields: Record<string, string>;
  /** Guild the modal was submitted from; null for DM contexts. */
  guildId: string | null;
  /** Channel the modal originated from; null if Discord didn't supply it. */
  channelId: string | null;
  /** Fresh interaction token for this modal submit (15 min). */
  interactionToken: string;
  /** Discord user id of the submitter. */
  userId: string;
  /** Display name of the submitter — global display name → username → id. */
  userDisplayName: string;
  /** The submitter's plugin-relevant capabilities. */
  capabilities: string[];
  hasCapability(capKey: string): boolean;
  log: Logger;
  publicBaseUrl?: string;
  /** Call a bot-side plugin RPC (same shape as command/component context). */
  botRpc(path: string, body?: unknown): Promise<unknown | null>;
}

/**
 * What a modal-submit handler may return:
 *  - nothing / null / undefined → the deferred ephemeral reply lingers
 *    as a brief "thinking" then quietly disappears
 *  - string or `{ content?, embeds?, ephemeral? }` → forwarded to
 *    `interactions.respond` to edit the deferred reply
 */
export type ModalReply =
  | void
  | null
  | string
  | {
      content?: string;
      embeds?: APIEmbed[];
      components?: MessageActionRow[];
      ephemeral?: boolean;
      flags?: MessageFlags;
    };

// ── Autocomplete interactions ───────────────────────────────────────────────

/**
 * Context passed to a plugin *autocomplete* handler. Triggered whenever
 * the user is typing into an option marked `autocomplete: true`. The
 * handler returns suggestion choices synchronously (within ~1.5 s) —
 * there is no botRpc surface here because the response IS the reply.
 */
export interface AutocompleteContext {
  /** Plugin key. */
  pluginKey: string;
  /** Slash command name being autocompleted. */
  commandName: string;
  /** Sub-command (if any). */
  subCommandName: string | null;
  /** Guild the user is in (null for DM contexts). */
  guildId: string | null;
  /** Discord user id of the user typing. */
  userId: string;
  /**
   * The option the cursor is currently in — name, current value, and
   * Discord's numeric type code. Most handlers only need `focused.value`
   * to build a search query.
   */
  focused: { name: string; value: string; type: number };
  /** All current option values (those the user has filled so far). */
  options: Record<string, unknown>;
  log: Logger;
}

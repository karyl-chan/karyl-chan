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
   * Call a bot-side plugin RPC endpoint (e.g. `/api/plugin/voice.play`).
   * Authorization header and base URL are filled in automatically.
   * Returns the parsed JSON body on 2xx, an empty object on 204,
   * or null on network / non-2xx errors (already logged).
   *
   * The plugin manifest must declare any RPC method used here under
   * `rpcMethodsUsed` or the bot will mint a token without that scope.
   */
  botRpc(path: string, body?: unknown): Promise<unknown | null>;
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
 * A plain string is shorthand for `{ content: string }`.
 * `embeds` / `components` are passed through to the bot's
 * interactions.respond endpoint unchanged (Discord component v1 shape:
 * an array of action rows, e.g. `[{ type: 1, components: [{ type: 2,
 * style: 5, label, url }] }]` for a link button).
 * Future fields added here are forward-compatible (bot ignores unknown keys).
 */
export type CommandReply =
  | string
  | {
      content?: string;
      embeds?: unknown[];
      components?: unknown[];
      ephemeral?: boolean;
      attachments?: MessageAttachment[];
    };

/** A single option definition attached to a command. */
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
  choices?: Array<{ name: string; value: string | number }>;
  /** Restrict channel option to specific channel types (e.g. "GUILD_TEXT"). */
  channel_types?: string[];
  /** For `sub_command` / `sub_command_group` — nested options. */
  options?: CommandOption[];
}

/** Discord interaction context types. */
export type InteractionContext = "Guild" | "BotDM" | "PrivateChannel";

// ── v2 新增型別 ─────────────────────────────────────────────────────────────

/**
 * Discord webhook POST body shape (`RESTPostAPIWebhookWithTokenJSONBody`).
 * Handy when a plugin exposes its own HTTP route for an admin-configured
 * `webhook`-source behavior to point at — the bot POSTs roughly this
 * shape — and the plugin wants a typed view of the payload it parses.
 */
export interface WebhookPayload {
  content?: string;
  username?: string;
  avatar_url?: string;
  embeds?: unknown[];
  allowed_mentions?: unknown;
  components?: unknown[];
  /** multipart 不支援；保留型別相容 */
  files?: unknown[];
  tts?: boolean;
  flags?: number;
}

// ── Component（按鈕）互動 ────────────────────────────────────────────────────

/**
 * Context passed to a plugin *component* (button) handler.
 *
 * A button "owned" by a plugin has a `custom_id` of the form
 * `kc:<pluginKey>:<componentId>[:<tail>]` (`kc` = "karyl plugin
 * component"). On a click the bot resolves the plugin, `deferUpdate`s
 * the interaction (acks without changing the message), and POSTs the
 * click here. Because component interactions create a *fresh*
 * interaction (and a fresh 15-minute token) on every click, the handler
 * isn't bound by the original message's age — it can keep editing that
 * message for as long as it exists.
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
  /** Guild the button was clicked in; null for DM contexts. */
  guildId: string | null;
  /** Channel the button's message lives in; null if Discord didn't supply it. */
  channelId: string | null;
  /** Id of the message the button is attached to. */
  messageId: string;
  /**
   * The (fresh, 15-min) interaction token for this click. The bot has
   * already `deferUpdate`d the interaction; pass this token to
   * `/api/plugin/interactions.followup` for an ephemeral nudge — e.g.
   * `ctx.botRpc("/api/plugin/interactions.followup", { interaction_token:
   * ctx.interactionToken, content, ephemeral: true })`. (Editing the
   * button's message is easier via the handler's return value.)
   */
  interactionToken: string;
  /** Discord user id of whoever clicked. */
  userId: string;
  /** Display name of the clicker — global display name → username → id. */
  userDisplayName: string;
  /**
   * The clicker's current voice-channel id in this guild, or null when
   * they aren't in voice (or this isn't a guild). Lets a plugin gate
   * controls on "you must be in the bot's voice channel".
   */
  voiceChannelId: string | null;
  /**
   * The clicker's plugin-relevant RBAC capabilities for THIS click, as
   * the bot resolved them: `admin` (if held) plus this plugin's own
   * `plugin:<pluginKey>:*` grants. Prefer `hasCapability()`.
   */
  capabilities: string[];
  /** True if the clicker holds `plugin:<this plugin's key>:<capKey>`, or `admin`. */
  hasCapability(capKey: string): boolean;
  /** Logger from the underlying Fastify instance. */
  log: Logger;
  /** Browser-reachable base URL for this plugin's HTTP surface, if the bot exposes one. */
  publicBaseUrl?: string;
  /**
   * Call a bot-side plugin RPC. The interaction was already `deferUpdate`d
   * by the bot, so use `/api/plugin/interactions.respond` to edit the
   * message the button is on (it PATCHes `@original`) — though returning a
   * `{ content?, embeds?, components? }` from the handler does that for
   * you — or `/api/plugin/interactions.followup` with `{ ephemeral: true }`
   * for a nudge that doesn't touch the message.
   */
  botRpc(path: string, body?: unknown): Promise<unknown | null>;
}

/**
 * What a component handler may return:
 *  - nothing / null / undefined → leave the message as-is (the bot has
 *    already acked the click with `deferUpdate`)
 *  - `{ content?, embeds?, components? }` → edit the message the button
 *    is on with these fields (forwarded to `interactions.respond`;
 *    omitted fields are left unchanged, `components: []` clears buttons).
 * For an ephemeral reply that doesn't touch the message use
 * `ctx.botRpc("/api/plugin/interactions.followup", { ephemeral: true, content })`.
 */
export type ComponentReply =
  | void
  | null
  | { content?: string; embeds?: unknown[]; components?: unknown[] };

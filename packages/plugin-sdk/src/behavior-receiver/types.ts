/**
 * The behavior webhook's request and reply shapes, as
 * packages/bot/docs/features/behavior-webhook-protocol.md states them.
 * The bot may add fields without calling it a breaking change: ignore the
 * ones you don't know. Bound to the fixtures' key lists by
 * tests/behavior-receiver-types.test.ts.
 */

/** `_meta.user`. Use `id` to tell users apart: names change. */
export interface BehaviorWebhookUser {
  id: string;
  username: string;
  global_name: string | null;
  discriminator: string;
  avatar: string | null;
}

/** One `_meta.attachments` entry. `url` is a signed CDN link that expires. */
export interface BehaviorWebhookAttachment {
  /** The Discord attachment id: a command's attachment option's `value`. */
  id: string;
  url: string;
  filename: string | null;
  content_type: string | null;
  size: number | null;
}

/** `_meta` of a message trigger. */
export interface MessageTriggerMeta {
  user: BehaviorWebhookUser;
  message_id: string;
  channel_id: string;
  /** null in a DM with the bot. */
  guild_id: string | null;
  behavior_id: number;
  attachments: BehaviorWebhookAttachment[];
  /** A regex trigger's groups, group 1 first (null: took no part); [] otherwise. */
  captures: (string | null)[];
  callback: BehaviorCallback;
}

/** One `_meta.options` entry. `type` is Discord's numeric option type. */
export interface CommandTriggerOption {
  name: string;
  type: number;
  value: string | number | boolean | null;
}

/**
 * `_meta.callback` (both triggers): this run's callback token. Send it as
 * `Authorization: Bearer <token>` to `<api_base>/api/plugin/interactions.respond`,
 * `.followup`, `.edit_followup` or `.delete_followup` to answer later
 * (after `{ defer: true }`, or to follow up). Only this run's reply.
 */
export interface BehaviorCallback {
  token: string;
  /** ISO 8601; 15 minutes after the command was used or the message sent. */
  expires_at: string;
  /** The bot's public base URL. */
  api_base: string;
}

/** `_meta` of a command. An interaction has no message, so no `message_id`. */
export interface CommandTriggerMeta {
  interaction_id: string;
  application_id: string;
  command_name: string;
  /** null on a command without subcommands. */
  sub_command_name: string | null;
  /** Reserved; always null for now. */
  sub_command_group: string | null;
  guild_id: string | null;
  channel_id: string;
  user: BehaviorWebhookUser;
  locale: string | null;
  options: CommandTriggerOption[];
  behavior_id: number;
  /** The invoked leaf's attachment options' files, in option order. */
  attachments: BehaviorWebhookAttachment[];
  /** Never the Discord interaction token. */
  callback: BehaviorCallback;
}

/** `_meta` of an admin test-fire: fixed values, never the admin's identity. */
export interface TestFireMeta {
  test: true;
  behavior_id: number;
  /** A placeholder user (`id: "0"`). */
  user: BehaviorWebhookUser;
  attachments: BehaviorWebhookAttachment[];
  /** A message trigger's test. */
  captures?: (string | null)[];
  /** A command's test: the leaf's own path. */
  sub_command_name?: string | null;
  sub_command_group?: string | null;
}

/** The JSON body of one request: a Discord webhook body plus `_meta`. */
export interface BehaviorWebhookPayload<
  Meta = MessageTriggerMeta | CommandTriggerMeta | TestFireMeta,
> {
  content: string;
  username: string;
  avatar_url: string;
  _meta: Meta;
}

/** A reply embed. Other fields are dropped; strings are cut to Discord's limits. */
export interface BehaviorReplyEmbed {
  title?: string;
  description?: string;
  url?: string;
  color?: number;
  timestamp?: string;
  footer?: { text: string; icon_url?: string };
  image?: { url: string };
  thumbnail?: { url: string };
  author?: { name: string; url?: string; icon_url?: string };
  fields?: { name: string; value: string; inline?: boolean }[];
}

/** The only component a reply may carry: a link button with an https url. */
export interface BehaviorReplyLinkButton {
  type: 2;
  style: 5;
  label: string;
  url: string;
}

export interface BehaviorReplyActionRow {
  type: 1;
  components: BehaviorReplyLinkButton[];
}

/**
 * The response body: what the bot shows the user. Every field is optional;
 * an empty body or an object with nothing to show is "no reply".
 */
export interface BehaviorReply {
  content?: string;
  embeds?: BehaviorReplyEmbed[];
  components?: BehaviorReplyActionRow[];
  /** Who sees the reply; the default depends on the trigger. */
  ephemeral?: boolean;
  /** Only SuppressEmbeds (4) and SuppressNotifications (4096) are kept. */
  flags?: number;
  /**
   * "Answer later": a command keeps its "thinking…" placeholder, a message
   * trigger shows typing, and you reply with `_meta.callback`. The other
   * fields are not shown.
   */
  defer?: true;
  /**
   * Files to attach: the bot GETs each `path` from your webhook URL's
   * origin (at most 5 files of 8 MiB, 25 MiB together; no redirects, no
   * credentials sent).
   * A file it can't get fails the reply. A reply of only attachments is a
   * reply.
   */
  attachments?: BehaviorReplyAttachment[];
  /**
   * DMs to other users (at most 5), sent after the reply is shown. Who may
   * be DMed is the behavior's rule (its DM allowlist, else members of the
   * triggering guild — any guild the bot is in for a DM trigger), at most
   * 10 a minute per behavior. A DM that is refused or fails does not fail
   * the reply.
   */
  direct_messages?: BehaviorDirectMessage[];
}

/** One direct message a reply asks for. */
export interface BehaviorDirectMessage {
  /** The Discord user id to DM. */
  user_id: string;
  content?: string;
  embeds?: BehaviorReplyEmbed[];
  components?: BehaviorReplyActionRow[];
  attachments?: BehaviorReplyAttachment[];
}

/** A file a reply attaches: its name in Discord, and a path on your webhook's origin. */
export interface BehaviorReplyAttachment {
  name: string;
  /** A plain path (`/files/chart.png`), never `//host` or a full URL. */
  path: string;
}

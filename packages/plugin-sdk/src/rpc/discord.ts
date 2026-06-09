/**
 * Typed Discord RPC namespace.
 *
 * Wraps the `/api/plugin/messages.*`, `/api/plugin/members.*`, and
 * `/api/plugin/interactions.*` RPCs that the in-tree plugins use most.
 * Other surfaces (channels, roles, users, guilds reads) live behind
 * `ctx.botRpc(path, body)` until they are typed in a follow-up bump.
 */

import type {
  APIEmbed,
  MessageActionRow,
  MessageAttachment,
  MessageFlags,
} from "../types.js";
import type { ModalData } from "../types.js";
import type { RpcCaller } from "./index.js";

// ─── messages.* ────────────────────────────────────────────────────────

export interface MessageSendArgs {
  channelId: string;
  content?: string;
  embeds?: APIEmbed[];
  components?: MessageActionRow[];
  attachments?: MessageAttachment[];
  allowedMentions?: { users?: string[]; roles?: string[] };
}

export interface MessageEditArgs {
  channelId: string;
  messageId: string;
  content?: string;
  embeds?: APIEmbed[];
  components?: MessageActionRow[];
  attachments?: MessageAttachment[];
}

export interface MessageDeleteArgs {
  channelId: string;
  messageId: string;
}

export interface MessageAddReactionArgs {
  channelId: string;
  messageId: string;
  /** Unicode emoji, or `name:id` for a custom one. */
  emoji: string;
}

export interface MessageHandle {
  id: string;
  channel_id: string;
}

export interface DiscordMessages {
  send(args: MessageSendArgs): Promise<MessageHandle>;
  edit(args: MessageEditArgs): Promise<MessageHandle>;
  delete(args: MessageDeleteArgs): Promise<void>;
  addReaction(args: MessageAddReactionArgs): Promise<void>;
}

// ─── members.* ─────────────────────────────────────────────────────────

export interface MemberGetArgs {
  guildId: string;
  userId: string;
}

export interface MemberSummary {
  // camelCase to match what the bot's /api/plugin/members.get actually
  // returns ({ userId, displayName, avatarUrl }).
  userId: string;
  displayName: string;
  avatarUrl: string | null;
}

export interface DiscordMembers {
  /** Returns null if the user isn't a member of the guild (left / never joined). */
  get(args: MemberGetArgs): Promise<MemberSummary | null>;
}

// ─── interactions.* ────────────────────────────────────────────────────

export interface InteractionRespondArgs {
  interactionToken: string;
  content?: string;
  ephemeral?: boolean;
  embeds?: APIEmbed[];
  components?: MessageActionRow[];
  attachments?: MessageAttachment[];
  flags?: MessageFlags;
}

export interface InteractionFollowupArgs {
  interactionToken: string;
  content?: string;
  ephemeral?: boolean;
  embeds?: APIEmbed[];
  components?: MessageActionRow[];
  flags?: MessageFlags;
}

export interface InteractionSendModalArgs {
  interactionId: string;
  interactionToken: string;
  modal: ModalData;
}

export interface DiscordInteractions {
  respond(args: InteractionRespondArgs): Promise<void>;
  followup(args: InteractionFollowupArgs): Promise<MessageHandle>;
  sendModal(args: InteractionSendModalArgs): Promise<{ ok: boolean }>;
}

// ─── Discord namespace assembly ────────────────────────────────────────

export interface Discord {
  messages: DiscordMessages;
  members: DiscordMembers;
  interactions: DiscordInteractions;
}

export function createDiscord(call: RpcCaller): Discord {
  return {
    messages: {
      async send(args) {
        const res = (await call("/api/plugin/messages.send", {
          channel_id: args.channelId,
          ...(args.content !== undefined ? { content: args.content } : {}),
          ...(args.embeds !== undefined ? { embeds: args.embeds } : {}),
          ...(args.components !== undefined
            ? { components: args.components }
            : {}),
          ...(args.attachments !== undefined
            ? { attachments: args.attachments }
            : {}),
          ...(args.allowedMentions !== undefined
            ? { allowed_mentions: args.allowedMentions }
            : {}),
        })) as MessageHandle;
        return res;
      },
      async edit(args) {
        const res = (await call("/api/plugin/messages.edit", {
          channel_id: args.channelId,
          message_id: args.messageId,
          ...(args.content !== undefined ? { content: args.content } : {}),
          ...(args.embeds !== undefined ? { embeds: args.embeds } : {}),
          ...(args.components !== undefined
            ? { components: args.components }
            : {}),
          ...(args.attachments !== undefined
            ? { attachments: args.attachments }
            : {}),
        })) as MessageHandle;
        return res;
      },
      async delete(args) {
        await call("/api/plugin/messages.delete", {
          channel_id: args.channelId,
          message_id: args.messageId,
        });
      },
      async addReaction(args) {
        await call("/api/plugin/messages.add_reaction", {
          channel_id: args.channelId,
          message_id: args.messageId,
          emoji: args.emoji,
        });
      },
    },
    members: {
      async get(args) {
        // The bot's members.get is a BATCH endpoint: it reads `user_ids`
        // (an array) and returns `{ members: MemberSummary[] }`, omitting
        // users who aren't in the guild. Send a one-element batch and
        // unwrap. (The old facade sent `user_id` + cast the wrapper object
        // as a single MemberSummary → every call 400'd.)
        const res = (await call("/api/plugin/members.get", {
          guild_id: args.guildId,
          user_ids: [args.userId],
        })) as { members?: MemberSummary[] };
        return res.members?.[0] ?? null;
      },
    },
    interactions: {
      async respond(args) {
        await call("/api/plugin/interactions.respond", {
          interaction_token: args.interactionToken,
          ...(args.content !== undefined ? { content: args.content } : {}),
          ...(args.ephemeral !== undefined
            ? { ephemeral: args.ephemeral }
            : {}),
          ...(args.embeds !== undefined ? { embeds: args.embeds } : {}),
          ...(args.components !== undefined
            ? { components: args.components }
            : {}),
          ...(args.attachments !== undefined
            ? { attachments: args.attachments }
            : {}),
          ...(args.flags !== undefined ? { flags: args.flags } : {}),
        });
      },
      async followup(args) {
        return (await call("/api/plugin/interactions.followup", {
          interaction_token: args.interactionToken,
          ...(args.content !== undefined ? { content: args.content } : {}),
          ...(args.ephemeral !== undefined
            ? { ephemeral: args.ephemeral }
            : {}),
          ...(args.embeds !== undefined ? { embeds: args.embeds } : {}),
          ...(args.components !== undefined
            ? { components: args.components }
            : {}),
          ...(args.flags !== undefined ? { flags: args.flags } : {}),
        })) as MessageHandle;
      },
      async sendModal(args) {
        return (await call("/api/plugin/interactions.send_modal", {
          interaction_id: args.interactionId,
          interaction_token: args.interactionToken,
          modal: args.modal,
        })) as { ok: boolean };
      },
    },
  };
}

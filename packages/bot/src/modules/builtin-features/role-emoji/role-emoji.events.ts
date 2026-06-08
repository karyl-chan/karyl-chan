import {
  MessageReaction,
  PartialMessageReaction,
  Role,
  type Client,
} from "discord.js";
import { findRoleReceiveMessage } from "./role-receive-message.model.js";
import {
  findRoleEmojiInGroup,
  findAllRoleEmojisInGroup,
} from "./role-emoji.model.js";
import { resolveBuiltinFeatureEnabled } from "../../feature-toggle/models/bot-feature-state.model.js";
import { botEventLog } from "../../bot-events/bot-event-log.js";
import { moduleLogger } from "../../../logger.js";

const log = moduleLogger("role-emoji-events");

/**
 * Hydrate a partial reaction (and its parent message) before we read
 * `guildId` / `emoji.name` / etc. off of it.
 *
 * After a bot restart, reactions on uncached messages arrive as
 * partials — discord.js fills in only what the gateway packet carried,
 * which omits `guildId` on the partial Message in practice. Earlier
 * versions of this handler bailed on `if (!guildId) return;`, which
 * looked exactly like "watch doesn't work after a restart." `fetch()`
 * round-trips to Discord and rebuilds a full Reaction + Message so the
 * downstream lookups have what they need.
 */
async function hydrateReaction(
  messageReaction: MessageReaction | PartialMessageReaction,
): Promise<MessageReaction | null> {
  if (messageReaction.partial) {
    try {
      await messageReaction.fetch();
    } catch (err) {
      log.error({ err }, "role-emoji: failed to fetch partial reaction");
      return null;
    }
  }
  if (messageReaction.message.partial) {
    try {
      await messageReaction.message.fetch();
    } catch (err) {
      log.error({ err }, "role-emoji: failed to fetch partial message");
      return null;
    }
  }
  return messageReaction as MessageReaction;
}

/**
 * Look up the role mapped to the emoji on a watched message. Returns
 * null when the message isn't being watched, the emoji isn't in the
 * bound group, or the mapped role has been deleted from the guild.
 */
async function getRoleForReaction(
  messageReaction: MessageReaction,
): Promise<Role | null> {
  const guildId = messageReaction.message.guildId;
  if (!guildId) return null;
  const channelId = messageReaction.message.channelId;
  const messageId = messageReaction.message.id;
  const watched = await findRoleReceiveMessage(guildId, channelId, messageId);
  if (!watched) return null;

  const groupId = watched.getDataValue("groupId") as number;
  const emojiId = messageReaction.emoji.id ?? "";
  const emojiChar = emojiId ? "" : (messageReaction.emoji.name ?? "");
  const roleEmoji = await findRoleEmojiInGroup(groupId, emojiChar, emojiId);
  if (!roleEmoji) return null;
  const roleId = roleEmoji.getDataValue("roleId") as string;
  return messageReaction.message.guild?.roles.cache.get(roleId) ?? null;
}

/**
 * Two emojis in a group can map to the SAME role (the mapping is keyed by
 * emoji, not role). On reaction-remove we must only revoke the role if the
 * user no longer holds ANY other reaction on this message whose emoji also
 * grants it — otherwise removing one emoji strips a role the user still earns
 * via another.
 */
async function userStillEarnsRoleViaOtherReaction(
  messageReaction: MessageReaction,
  userId: string,
  roleId: string,
): Promise<boolean> {
  const guildId = messageReaction.message.guildId;
  if (!guildId) return false;
  const watched = await findRoleReceiveMessage(
    guildId,
    messageReaction.message.channelId,
    messageReaction.message.id,
  );
  if (!watched) return false;
  const groupId = watched.getDataValue("groupId") as number;

  const removedId = messageReaction.emoji.id ?? "";
  const removedChar = removedId ? "" : (messageReaction.emoji.name ?? "");

  // Other emojis in the group that grant the same role (excluding the one
  // whose reaction was just removed).
  const siblings = (await findAllRoleEmojisInGroup(groupId)).filter((re) => {
    if ((re.getDataValue("roleId") as string) !== roleId) return false;
    const eId = (re.getDataValue("emojiId") as string) ?? "";
    const eChar = (re.getDataValue("emojiChar") as string) ?? "";
    return !(eId === removedId && eChar === removedChar);
  });
  if (siblings.length === 0) return false;

  for (const sib of siblings) {
    const eId = (sib.getDataValue("emojiId") as string) ?? "";
    const eChar = (sib.getDataValue("emojiChar") as string) ?? "";
    const reaction = messageReaction.message.reactions.cache.find((r) =>
      eId ? r.emoji.id === eId : r.emoji.name === eChar,
    );
    if (!reaction) continue;
    const users = await reaction.users.fetch().catch(() => null);
    if (users?.has(userId)) return true;
  }
  return false;
}

export function registerRoleEmojiEvents(client: Client): void {
  client.on("messageReactionAdd", async (messageReaction, user) => {
    try {
      if (user.id === client.user?.id) return;
      const hydrated = await hydrateReaction(messageReaction);
      if (!hydrated) return;
      if (
        !(await resolveBuiltinFeatureEnabled(
          "role-emoji",
          hydrated.message.guildId,
        ))
      ) {
        return;
      }
      const role = await getRoleForReaction(hydrated);
      if (!role) return;
      const member = await hydrated.message.guild?.members
        .fetch(user.id)
        .catch(() => null);
      if (!member) return;
      try {
        await member.roles.add(role);
        botEventLog.record(
          "info",
          "feature",
          `Role auto-granted via reaction: ${role.name}`,
          {
            guildId: hydrated.message.guildId,
            channelId: hydrated.message.channelId,
            messageId: hydrated.message.id,
            userId: user.id,
            roleId: role.id,
            emoji: hydrated.emoji.id ?? hydrated.emoji.name ?? "",
          },
        );
      } catch (roleErr) {
        botEventLog.record(
          "error",
          "feature",
          `Role grant/revoke failed: ${(roleErr as Error).message}`,
          {
            guildId: hydrated.message.guildId,
            userId: user.id,
            roleId: role.id,
            action: "add",
          },
        );
        throw roleErr;
      }
    } catch (ex) {
      log.error({ err: ex }, "role-emoji messageReactionAdd failed");
    }
  });

  client.on("messageReactionRemove", async (messageReaction, user) => {
    try {
      if (user.id === client.user?.id) return;
      const hydrated = await hydrateReaction(messageReaction);
      if (!hydrated) return;
      if (
        !(await resolveBuiltinFeatureEnabled(
          "role-emoji",
          hydrated.message.guildId,
        ))
      ) {
        return;
      }
      const role = await getRoleForReaction(hydrated);
      if (!role) return;
      const member = await hydrated.message.guild?.members
        .fetch(user.id)
        .catch(() => null);
      if (!member) return;
      // Keep the role if another emoji's reaction by this user still grants it.
      if (
        await userStillEarnsRoleViaOtherReaction(hydrated, user.id, role.id)
      ) {
        return;
      }
      try {
        await member.roles.remove(role);
        botEventLog.record(
          "info",
          "feature",
          `Role auto-revoked via reaction: ${role.name}`,
          {
            guildId: hydrated.message.guildId,
            channelId: hydrated.message.channelId,
            messageId: hydrated.message.id,
            userId: user.id,
            roleId: role.id,
            emoji: hydrated.emoji.id ?? hydrated.emoji.name ?? "",
          },
        );
      } catch (roleErr) {
        botEventLog.record(
          "error",
          "feature",
          `Role grant/revoke failed: ${(roleErr as Error).message}`,
          {
            guildId: hydrated.message.guildId,
            userId: user.id,
            roleId: role.id,
            action: "remove",
          },
        );
        throw roleErr;
      }
    } catch (ex) {
      log.error({ err: ex }, "role-emoji messageReactionRemove failed");
    }
  });
}

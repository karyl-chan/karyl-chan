import {
  ApplicationCommandOptionType,
  ApplicationCommandType,
  type ChatInputCommandInteraction,
  DiscordAPIError,
  PermissionFlagsBits,
  RESTJSONErrorCodes,
  type Role,
} from "discord.js";
import { moduleLogger } from "../../../logger.js";

const log = moduleLogger("role-emoji-commands");
import {
  addRoleEmoji,
  findAllRoleEmojisInGroup,
  findRoleEmojiInGroup,
  removeRoleEmoji,
} from "./role-emoji.model.js";
import {
  findRoleReceiveMessage,
  removeRoleReceiveMessage,
  upsertRoleReceiveMessage,
} from "./role-receive-message.model.js";
import {
  addRoleEmojiGroup,
  findAllRoleEmojiGroups,
  findRoleEmojiGroupByName,
  removeRoleEmojiGroup,
} from "./role-emoji-group.model.js";
import { registerInProcessCommand } from "../in-process-command-registry.service.js";
import { FAILED_COLOR, SUCCEEDED_COLOR } from "../../../utils/constant.js";
import {
  describeEn,
  localizedDescriptions,
  tForInteraction,
} from "../../../i18n/index.js";

// BMP emoji + symbol range. Lower bound MUST be   (General
// Punctuation), not   (ASCII space) — using literal chars in
// this character class is fragile because tools can normalise
// invisible-but-distinct codepoints during file writes. Keep the
// escape syntax permanent.
const EMOJI_REGEX =
  /(©|®|[ -㌀]|\ud83c[\udc00-\udfff]|\ud83d[\udc00-\udfff]|\ud83e[\udc00-\udfff])|^<(a?:[^:>]+:)([^>]+)>$/;
const DEFAULT_GROUP_NAME = "default";

/**
 * `/role-emoji ...`
 *
 * Two flat subcommand surfaces (mappings + watch state) plus a
 * `group` subcommand-group for emoji-group CRUD. discordx-equivalent
 * structure preserved verbatim — this is purely the registration
 * mechanism that changed.
 */

// ── group ───────────────────────────────────────────────────────────────

async function groupAdd(command: ChatInputCommandInteraction): Promise<void> {
  const name = command.options.getString("name", true).trim();
  if (!name) {
    await command.reply({
      content: tForInteraction(command, "role-emoji.group.name-empty"),
      flags: "Ephemeral",
    });
    return;
  }
  const guildId = command.guildId as string;
  try {
    const existing = await findRoleEmojiGroupByName(guildId, name);
    if (existing) {
      await command.reply({
        embeds: [
          {
            color: FAILED_COLOR,
            title: tForInteraction(command, "common.status.failed"),
            description: tForInteraction(
              command,
              "role-emoji.group.already-exists",
              { name },
            ),
          },
        ],
        flags: "Ephemeral",
      });
      return;
    }
    await addRoleEmojiGroup(guildId, name);
    await command.reply({
      embeds: [
        {
          color: SUCCEEDED_COLOR,
          title: tForInteraction(command, "common.status.succeeded"),
          description: tForInteraction(command, "role-emoji.group.created", {
            name,
          }),
        },
      ],
      flags: "Ephemeral",
    });
  } catch (ex) {
    log.error({ err: ex }, "role-emoji groupAdd failed");
  }
}

async function groupRemove(
  command: ChatInputCommandInteraction,
): Promise<void> {
  const name = command.options.getString("name", true);
  const guildId = command.guildId as string;
  try {
    const existing = await findRoleEmojiGroupByName(guildId, name.trim());
    if (!existing) {
      await command.reply({
        embeds: [
          {
            color: FAILED_COLOR,
            title: tForInteraction(command, "common.status.failed"),
            description: tForInteraction(command, "role-emoji.group.not-found", {
              name,
            }),
          },
        ],
        flags: "Ephemeral",
      });
      return;
    }
    await removeRoleEmojiGroup(guildId, existing.getDataValue("id") as number);
    await command.reply({
      embeds: [
        {
          color: SUCCEEDED_COLOR,
          title: tForInteraction(command, "common.status.succeeded"),
          description: tForInteraction(command, "role-emoji.group.deleted", {
            name,
          }),
        },
      ],
      flags: "Ephemeral",
    });
  } catch (ex) {
    log.error({ err: ex }, "role-emoji groupRemove failed");
  }
}

async function groupList(command: ChatInputCommandInteraction): Promise<void> {
  const guildId = command.guildId as string;
  try {
    const groups = await findAllRoleEmojiGroups(guildId);
    if (groups.length === 0) {
      await command.reply({
        embeds: [
          {
            color: SUCCEEDED_COLOR,
            description: tForInteraction(command, "role-emoji.group.none"),
          },
        ],
        flags: "Ephemeral",
      });
      return;
    }
    const noMappingsLabel = tForInteraction(
      command,
      "role-emoji.group.no-mappings",
    );
    const fields = await Promise.all(
      groups.map(async (g) => {
        const groupId = g.getDataValue("id") as number;
        const groupName = g.getDataValue("name") as string;
        const mappings = await findAllRoleEmojisInGroup(groupId);
        const lines = mappings.map((m) => {
          const emojiChar = m.getDataValue("emojiChar") as string;
          const emojiId = m.getDataValue("emojiId") as string;
          const emojiName = m.getDataValue("emojiName") as string;
          const role = command.guild?.roles.cache.find(
            (r) => r.id === m.getDataValue("roleId"),
          );
          const display = emojiChar ? emojiChar : `<${emojiName}${emojiId}>`;
          return `${display} → \`${role?.name ?? m.getDataValue("roleId")}\``;
        });
        return {
          name: groupName,
          value: lines.length ? lines.join("\n") : noMappingsLabel,
        };
      }),
    );
    await command.reply({
      embeds: [{ color: SUCCEEDED_COLOR, fields }],
      flags: "Ephemeral",
    });
  } catch (ex) {
    log.error({ err: ex }, "role-emoji groupList failed");
  }
}

// ── mappings (top-level) ────────────────────────────────────────────────

async function mappingAdd(command: ChatInputCommandInteraction): Promise<void> {
  const emoji = command.options.getString("emoji", true);
  const role = command.options.getRole("role", true) as Role;
  const groupNameRaw = command.options.getString("group", false);
  const guildId = command.guildId as string;
  try {
    const resolvedName = (groupNameRaw ?? "").trim() || DEFAULT_GROUP_NAME;
    let group = await findRoleEmojiGroupByName(guildId, resolvedName);
    if (!group) {
      if (resolvedName === DEFAULT_GROUP_NAME) {
        group = await addRoleEmojiGroup(guildId, DEFAULT_GROUP_NAME);
      } else {
        await command.reply({
          embeds: [
            {
              color: FAILED_COLOR,
              title: tForInteraction(command, "common.status.failed"),
              description: tForInteraction(
                command,
                "role-emoji.group.not-found",
                { name: resolvedName },
              ),
            },
          ],
          flags: "Ephemeral",
        });
        return;
      }
    }
    const groupId = group.getDataValue("id") as number;
    const emojiMatch = EMOJI_REGEX.exec(emoji);
    if (!emojiMatch) {
      await command.reply({
        content: tForInteraction(command, "role-emoji.mapping.not-emoji", {
          emoji,
        }),
        flags: "Ephemeral",
      });
      return;
    }
    const emojiChar = emojiMatch[1] ?? "";
    const emojiName = emojiMatch[2] ?? "";
    const emojiId = emojiMatch[3] ?? "";
    const recorded = await findRoleEmojiInGroup(groupId, emojiChar, emojiId);
    if (recorded) {
      const mappedRole = command.guild?.roles.cache.find(
        (x) => x.id === recorded.getDataValue("roleId"),
      );
      await command.reply({
        embeds: [
          {
            color: FAILED_COLOR,
            title: tForInteraction(command, "common.status.failed"),
            description: tForInteraction(command, "role-emoji.mapping.already", {
              emoji,
              roleName:
                mappedRole?.name ?? (recorded.getDataValue("roleId") as string),
            }),
          },
        ],
        flags: "Ephemeral",
      });
      return;
    }
    await addRoleEmoji(groupId, role.id, emojiChar, emojiName, emojiId);
    await command.reply({
      embeds: [
        {
          color: SUCCEEDED_COLOR,
          title: tForInteraction(command, "common.status.succeeded"),
          description: tForInteraction(command, "role-emoji.mapping.added", {
            emoji,
            roleName: role.name,
            group: resolvedName,
          }),
        },
      ],
      flags: "Ephemeral",
    });
  } catch (ex) {
    log.error({ err: ex }, "role-emoji mappingAdd failed");
  }
}

async function mappingRemove(
  command: ChatInputCommandInteraction,
): Promise<void> {
  const groupName = command.options.getString("group", true);
  const emoji = command.options.getString("emoji", true);
  const guildId = command.guildId as string;
  try {
    const group = await findRoleEmojiGroupByName(guildId, groupName.trim());
    if (!group) {
      await command.reply({
        embeds: [
          {
            color: FAILED_COLOR,
            title: tForInteraction(command, "common.status.failed"),
            description: tForInteraction(command, "role-emoji.group.not-found", {
              name: groupName,
            }),
          },
        ],
        flags: "Ephemeral",
      });
      return;
    }
    const groupId = group.getDataValue("id") as number;
    const emojiMatch = EMOJI_REGEX.exec(emoji);
    if (!emojiMatch) {
      await command.reply({
        content: tForInteraction(command, "role-emoji.mapping.not-emoji", {
          emoji,
        }),
        flags: "Ephemeral",
      });
      return;
    }
    const emojiChar = emojiMatch[1] ?? "";
    const emojiId = emojiMatch[3] ?? "";
    const recorded = await findRoleEmojiInGroup(groupId, emojiChar, emojiId);
    if (!recorded) {
      await command.reply({
        embeds: [
          {
            color: FAILED_COLOR,
            title: tForInteraction(command, "common.status.failed"),
            description: tForInteraction(command, "role-emoji.mapping.not-found", {
              emoji,
              group: groupName,
            }),
          },
        ],
        flags: "Ephemeral",
      });
      return;
    }
    await removeRoleEmoji(groupId, emojiChar, emojiId);
    await command.reply({
      embeds: [
        {
          color: SUCCEEDED_COLOR,
          title: tForInteraction(command, "common.status.succeeded"),
          description: tForInteraction(command, "role-emoji.mapping.removed", {
            emoji,
            group: groupName,
          }),
        },
      ],
      flags: "Ephemeral",
    });
  } catch (ex) {
    log.error({ err: ex }, "role-emoji mappingRemove failed");
  }
}

// ── watch / stop-watch ──────────────────────────────────────────────────

async function watch(command: ChatInputCommandInteraction): Promise<void> {
  // Reacting with N emoji is N REST round-trips and easily blows past
  // Discord's 3-second interaction window — defer up front so the user
  // sees a "thinking…" spinner instead of "interaction failed".
  await command.deferReply({ flags: "Ephemeral" }).catch(() => {});
  const messageId = command.options.getString("message-id", true);
  const groupNameRaw = command.options.getString("group", false);
  const guildId = command.guildId as string;
  const resolvedName = (groupNameRaw ?? "").trim() || DEFAULT_GROUP_NAME;
  try {
    const group = await findRoleEmojiGroupByName(guildId, resolvedName);
    if (!group) {
      await command.editReply({
        embeds: [
          {
            color: FAILED_COLOR,
            title: tForInteraction(command, "common.status.failed"),
            description: tForInteraction(command, "role-emoji.group.not-found", {
              name: resolvedName,
            }),
          },
        ],
      });
      return;
    }
    const groupId = group.getDataValue("id") as number;

    // force: true bypasses the discord.js message cache — a cached
    // message keeps its reactions cache only as gateway events arrive,
    // so without forcing we may see an empty reactions cache for a
    // message that already has reactions on Discord.
    const message = await command.channel?.messages
      .fetch({ message: messageId, force: true })
      .catch(() => null);
    if (!message) {
      await command.editReply({
        embeds: [
          {
            color: FAILED_COLOR,
            title: tForInteraction(command, "common.status.failed"),
            description: tForInteraction(
              command,
              "role-emoji.watch.message-not-found",
              { messageId },
            ),
          },
        ],
      });
      return;
    }

    const previouslyWatched = await findRoleReceiveMessage(
      guildId,
      command.channelId,
      messageId,
    );
    // Upsert binds (or rebinds) the message to the chosen group —
    // single-group-per-watch is enforced at the schema level.
    await upsertRoleReceiveMessage(
      guildId,
      command.channelId,
      messageId,
      groupId,
    );

    const mappings = await findAllRoleEmojisInGroup(groupId);
    const failed: string[] = [];
    for (const re of mappings) {
      const emojiChar = re.getDataValue("emojiChar") as string;
      const emojiId = re.getDataValue("emojiId") as string;
      const emojiName = re.getDataValue("emojiName") as string;
      // Already on the message? Skip — Discord rejects bot-side reacts
      // on emoji it can't access (off-guild custom → 10014 Unknown
      // Emoji) even when the visual reaction is already present.
      if (message.reactions.cache.has(emojiId || emojiChar)) continue;
      const resolvable = resolveReactable(
        command,
        emojiChar,
        emojiId,
        emojiName,
      );
      if (!resolvable) {
        failed.push(emojiChar || emojiId);
        continue;
      }
      try {
        await message.react(resolvable);
      } catch (err) {
        // 10014 Unknown Emoji = bot can't access this custom emoji;
        // mapping still works for users who can react — treat as benign.
        if (
          err instanceof DiscordAPIError &&
          err.code === RESTJSONErrorCodes.UnknownEmoji
        ) {
          log.warn(
            { resolvable: String(resolvable) },
            "role-emoji watch: skipping inaccessible emoji (10014)",
          );
          continue;
        }
        log.error(
          { err, resolvable: String(resolvable) },
          "role-emoji watch: react failed",
        );
        failed.push(emojiChar || emojiId);
      }
    }

    const baseDescKey = previouslyWatched
      ? "role-emoji.watch.bound"
      : "role-emoji.watch.watching";
    const baseDesc = tForInteraction(command, baseDescKey, {
      messageId,
      group: resolvedName,
    });
    const failedSuffix = failed.length
      ? `\n\n${tForInteraction(command, "role-emoji.watch.cannot-react-prefix")}${failed
          .map((f) => `\`${f}\``)
          .join(", ")}`
      : "";
    await command.editReply({
      embeds: [
        {
          color: failed.length ? FAILED_COLOR : SUCCEEDED_COLOR,
          title: tForInteraction(
            command,
            failed.length ? "common.status.partial" : "common.status.succeeded",
          ),
          description: baseDesc + failedSuffix,
        },
      ],
    });
  } catch (ex) {
    log.error({ err: ex }, "role-emoji watch failed");
    await command
      .editReply({
        embeds: [
          {
            color: FAILED_COLOR,
            title: tForInteraction(command, "common.status.failed"),
            description: ex instanceof Error ? ex.message : String(ex),
          },
        ],
      })
      .catch(() => {});
  }
}

async function stopWatch(command: ChatInputCommandInteraction): Promise<void> {
  await command.deferReply({ flags: "Ephemeral" }).catch(() => {});
  const messageId = command.options.getString("message-id", true);
  const guildId = command.guildId as string;
  try {
    const recorded = await findRoleReceiveMessage(
      guildId,
      command.channelId,
      messageId,
    );
    if (recorded) {
      await removeRoleReceiveMessage(guildId, command.channelId, messageId);
      await command.editReply({
        embeds: [
          {
            color: SUCCEEDED_COLOR,
            title: tForInteraction(command, "common.status.succeeded"),
            description: tForInteraction(command, "role-emoji.watch.stopped", {
              messageId,
            }),
          },
        ],
      });
    } else {
      await command.editReply({
        embeds: [
          {
            color: SUCCEEDED_COLOR,
            title: tForInteraction(command, "common.status.no-action"),
            description: tForInteraction(command, "role-emoji.watch.not-watched", {
              messageId,
            }),
          },
        ],
      });
    }
  } catch (ex) {
    log.error({ err: ex }, "role-emoji stopWatch failed");
    await command
      .editReply({
        embeds: [
          {
            color: FAILED_COLOR,
            title: tForInteraction(command, "common.status.failed"),
            description: ex instanceof Error ? ex.message : String(ex),
          },
        ],
      })
      .catch(() => {});
  }
}

/**
 * Build something `message.react()` accepts from a stored role-emoji
 * row. Returns null when the row's emoji can't be turned into anything
 * valid (e.g., a custom emoji whose id we have but whose `name` we
 * never recorded — Discord requires `name:id` for non-cached customs).
 */
function resolveReactable(
  command: ChatInputCommandInteraction,
  emojiChar: string,
  emojiId: string,
  emojiName: string,
): string | null {
  if (emojiChar) return emojiChar;
  if (!emojiId) return null;
  const cached = command.guild?.emojis.resolve(emojiId);
  if (cached) return cached.toString();
  const nameOnly = (emojiName ?? "").replace(/^a?:/, "").replace(/:$/, "");
  const animated = (emojiName ?? "").startsWith("a:");
  if (!nameOnly) return null;
  return `${animated ? "a:" : ""}${nameOnly}:${emojiId}`;
}

export function registerRoleEmojiCommands(): void {
  registerInProcessCommand({
    data: {
      type: ApplicationCommandType.ChatInput,
      name: "role-emoji",
      description: describeEn("role-emoji.command.description"),
      descriptionLocalizations: localizedDescriptions(
        "role-emoji.command.description",
      ),
      // Discord ManageRoles bit. Same as `'268435456'` in the old
      // SlashGroup decorator (1 << 28 = 268_435_456).
      defaultMemberPermissions: PermissionFlagsBits.ManageRoles,
      options: [
        // Subcommand group: /role-emoji group <add|remove|list>
        {
          type: ApplicationCommandOptionType.SubcommandGroup,
          name: "group",
          description: describeEn("role-emoji.command.group.description"),
          descriptionLocalizations: localizedDescriptions(
            "role-emoji.command.group.description",
          ),
          options: [
            {
              type: ApplicationCommandOptionType.Subcommand,
              name: "add",
              description: describeEn("role-emoji.command.group.add-description"),
              descriptionLocalizations: localizedDescriptions(
                "role-emoji.command.group.add-description",
              ),
              options: [
                {
                  type: ApplicationCommandOptionType.String,
                  name: "name",
                  description: describeEn("role-emoji.option.name"),
                  descriptionLocalizations: localizedDescriptions(
                    "role-emoji.option.name",
                  ),
                  required: true,
                },
              ],
            },
            {
              type: ApplicationCommandOptionType.Subcommand,
              name: "remove",
              description: describeEn(
                "role-emoji.command.group.remove-description",
              ),
              descriptionLocalizations: localizedDescriptions(
                "role-emoji.command.group.remove-description",
              ),
              options: [
                {
                  type: ApplicationCommandOptionType.String,
                  name: "name",
                  description: describeEn("role-emoji.option.name"),
                  descriptionLocalizations: localizedDescriptions(
                    "role-emoji.option.name",
                  ),
                  required: true,
                },
              ],
            },
            {
              type: ApplicationCommandOptionType.Subcommand,
              name: "list",
              description: describeEn(
                "role-emoji.command.group.list-description",
              ),
              descriptionLocalizations: localizedDescriptions(
                "role-emoji.command.group.list-description",
              ),
            },
          ],
        },
        // Top-level mappings + watch
        {
          type: ApplicationCommandOptionType.Subcommand,
          name: "add",
          description: describeEn("role-emoji.command.add-description"),
          descriptionLocalizations: localizedDescriptions(
            "role-emoji.command.add-description",
          ),
          options: [
            {
              type: ApplicationCommandOptionType.String,
              name: "emoji",
              description: describeEn("role-emoji.option.emoji"),
              descriptionLocalizations: localizedDescriptions(
                "role-emoji.option.emoji",
              ),
              required: true,
            },
            {
              type: ApplicationCommandOptionType.Role,
              name: "role",
              description: describeEn("role-emoji.option.role"),
              descriptionLocalizations: localizedDescriptions(
                "role-emoji.option.role",
              ),
              required: true,
            },
            {
              type: ApplicationCommandOptionType.String,
              name: "group",
              description: describeEn("role-emoji.option.group-with-default", {
                default: DEFAULT_GROUP_NAME,
              }),
              descriptionLocalizations: localizedDescriptions(
                "role-emoji.option.group-with-default",
                { default: DEFAULT_GROUP_NAME },
              ),
              required: false,
            },
          ],
        },
        {
          type: ApplicationCommandOptionType.Subcommand,
          name: "remove",
          description: describeEn("role-emoji.command.remove-description"),
          descriptionLocalizations: localizedDescriptions(
            "role-emoji.command.remove-description",
          ),
          options: [
            {
              type: ApplicationCommandOptionType.String,
              name: "group",
              description: describeEn("role-emoji.option.group"),
              descriptionLocalizations: localizedDescriptions(
                "role-emoji.option.group",
              ),
              required: true,
            },
            {
              type: ApplicationCommandOptionType.String,
              name: "emoji",
              description: describeEn("role-emoji.option.emoji"),
              descriptionLocalizations: localizedDescriptions(
                "role-emoji.option.emoji",
              ),
              required: true,
            },
          ],
        },
        {
          type: ApplicationCommandOptionType.Subcommand,
          name: "watch",
          description: describeEn("role-emoji.command.watch-description"),
          descriptionLocalizations: localizedDescriptions(
            "role-emoji.command.watch-description",
          ),
          options: [
            {
              type: ApplicationCommandOptionType.String,
              name: "message-id",
              description: describeEn("role-emoji.option.message-id"),
              descriptionLocalizations: localizedDescriptions(
                "role-emoji.option.message-id",
              ),
              required: true,
            },
            {
              type: ApplicationCommandOptionType.String,
              name: "group",
              description: describeEn("role-emoji.option.group-watch", {
                default: DEFAULT_GROUP_NAME,
              }),
              descriptionLocalizations: localizedDescriptions(
                "role-emoji.option.group-watch",
                { default: DEFAULT_GROUP_NAME },
              ),
              required: false,
            },
          ],
        },
        {
          type: ApplicationCommandOptionType.Subcommand,
          name: "stop-watch",
          description: describeEn("role-emoji.command.stop-watch-description"),
          descriptionLocalizations: localizedDescriptions(
            "role-emoji.command.stop-watch-description",
          ),
          options: [
            {
              type: ApplicationCommandOptionType.String,
              name: "message-id",
              description: describeEn("role-emoji.option.message-id"),
              descriptionLocalizations: localizedDescriptions(
                "role-emoji.option.message-id",
              ),
              required: true,
            },
          ],
        },
      ],
    },
    scope: "guild",
    featureKey: "role-emoji",
    handler: async (interaction) => {
      const group = interaction.options.getSubcommandGroup(false);
      const sub = interaction.options.getSubcommand();
      if (group === "group") {
        if (sub === "add") return groupAdd(interaction);
        if (sub === "remove") return groupRemove(interaction);
        if (sub === "list") return groupList(interaction);
      } else {
        if (sub === "add") return mappingAdd(interaction);
        if (sub === "remove") return mappingRemove(interaction);
        if (sub === "watch") return watch(interaction);
        if (sub === "stop-watch") return stopWatch(interaction);
      }
      await interaction.reply({
        content: tForInteraction(interaction, "common.unknown-subcommand", {
          sub: `${group ?? ""}/${sub}`,
        }),
        flags: "Ephemeral",
      });
    },
  });
}

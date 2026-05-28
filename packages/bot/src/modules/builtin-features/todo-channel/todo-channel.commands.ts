import {
  ApplicationCommandOptionType,
  ApplicationCommandType,
  PermissionFlagsBits,
  type ChatInputCommandInteraction,
  type TextChannel,
  MessageType,
} from "discord.js";
import { addTodoChannel, findTodoChannel } from "./todo-channel.model.js";
import { addTodoMessage } from "./todo-message.model.js";
import { registerInProcessCommand } from "../in-process-command-registry.service.js";
import { SUCCEEDED_COLOR } from "../../../utils/constant.js";
import {
  describeEn,
  localizedDescriptions,
  tForInteraction,
} from "../../../i18n/index.js";

/**
 * `/todo-channel <watch|stop-watch|check-cache>`
 *
 * Replaces the discordx-decorated TodoChannelCommands class.
 * Configuration is per-channel; the actual todo bookkeeping (add /
 * remove on reaction) lives in events/todo-channel.events.ts and is
 * gated by the guild-level `todo` built-in feature toggle.
 */

async function watchChannel(
  command: ChatInputCommandInteraction,
): Promise<void> {
  const recordedTodoChannel = await findTodoChannel(
    command.guildId as string,
    command.channelId,
  );
  if (!recordedTodoChannel) {
    await addTodoChannel(command.guildId as string, command.channelId);
    await command.reply({
      embeds: [
        {
          color: SUCCEEDED_COLOR,
          title: tForInteraction(command, "common.status.succeeded"),
          description: tForInteraction(command, "todo-channel.watch.added"),
        },
      ],
      flags: "Ephemeral",
    });
  } else {
    await command.reply({
      embeds: [
        {
          color: SUCCEEDED_COLOR,
          title: tForInteraction(command, "common.status.no-action"),
          description: tForInteraction(command, "todo-channel.watch.already"),
        },
      ],
      flags: "Ephemeral",
    });
  }
}

async function stopWatchChannel(
  command: ChatInputCommandInteraction,
): Promise<void> {
  const recordedTodoChannel = await findTodoChannel(
    command.guildId as string,
    command.channelId,
  );
  if (recordedTodoChannel) {
    await recordedTodoChannel.destroy();
    await command.reply({
      embeds: [
        {
          color: SUCCEEDED_COLOR,
          title: tForInteraction(command, "common.status.succeeded"),
          description: tForInteraction(command, "todo-channel.watch.removed"),
        },
      ],
      flags: "Ephemeral",
    });
  } else {
    await command.reply({
      embeds: [
        {
          color: SUCCEEDED_COLOR,
          title: tForInteraction(command, "common.status.no-action"),
          description: tForInteraction(
            command,
            "todo-channel.watch.not-watched",
          ),
        },
      ],
      flags: "Ephemeral",
    });
  }
}

async function checkCacheMessage(
  command: ChatInputCommandInteraction,
): Promise<void> {
  const channel = command.client.channels.cache.get(
    command.channelId,
  ) as TextChannel;
  const messages = await channel.messages.fetch({ limit: 100, cache: false });
  const filteredMessage = [
    ...messages
      .filter(
        (x) =>
          x.reactions.cache.size === 0 &&
          (x.mentions.members?.size ?? 0) > 0 &&
          (!x.mentions.members?.find((m) => m.id === command.client.user?.id) ||
            x.type === MessageType.Reply),
      )
      .values(),
  ].reverse();
  for (const eachMessage of filteredMessage) {
    await addTodoMessage(eachMessage);
  }
  await command.reply({
    embeds: [
      {
        color: SUCCEEDED_COLOR,
        title: tForInteraction(command, "todo-channel.cache-checked"),
      },
    ],
    flags: "Ephemeral",
  });
}

export function registerTodoChannelCommands(): void {
  registerInProcessCommand({
    data: {
      type: ApplicationCommandType.ChatInput,
      name: "todo-channel",
      description: describeEn("todo-channel.command.description"),
      descriptionLocalizations: localizedDescriptions(
        "todo-channel.command.description",
      ),
      defaultMemberPermissions: PermissionFlagsBits.ManageChannels,
      options: [
        {
          type: ApplicationCommandOptionType.Subcommand,
          name: "watch",
          description: describeEn("todo-channel.command.watch-description"),
          descriptionLocalizations: localizedDescriptions(
            "todo-channel.command.watch-description",
          ),
        },
        {
          type: ApplicationCommandOptionType.Subcommand,
          name: "stop-watch",
          description: describeEn("todo-channel.command.stop-watch-description"),
          descriptionLocalizations: localizedDescriptions(
            "todo-channel.command.stop-watch-description",
          ),
        },
        {
          type: ApplicationCommandOptionType.Subcommand,
          name: "check-cache",
          description: describeEn(
            "todo-channel.command.check-cache-description",
          ),
          descriptionLocalizations: localizedDescriptions(
            "todo-channel.command.check-cache-description",
          ),
        },
      ],
    },
    scope: "guild",
    featureKey: "todo",
    handler: async (interaction) => {
      const sub = interaction.options.getSubcommand();
      if (sub === "watch") return watchChannel(interaction);
      if (sub === "stop-watch") return stopWatchChannel(interaction);
      if (sub === "check-cache") return checkCacheMessage(interaction);
      await interaction.reply({
        content: tForInteraction(interaction, "common.unknown-subcommand", {
          sub,
        }),
        flags: "Ephemeral",
      });
    },
  });
}

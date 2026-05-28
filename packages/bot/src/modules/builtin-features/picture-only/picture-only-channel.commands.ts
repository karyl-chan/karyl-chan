import {
  ApplicationCommandOptionType,
  ApplicationCommandType,
  PermissionFlagsBits,
  type ChatInputCommandInteraction,
} from "discord.js";
import { PictureOnlyChannel } from "./picture-only-channel.model.js";
import { registerInProcessCommand } from "../in-process-command-registry.service.js";
import { SUCCEEDED_COLOR } from "../../../utils/constant.js";
import {
  describeEn,
  localizedDescriptions,
  tForInteraction,
} from "../../../i18n/index.js";

/**
 * `/picture-only-channel <watch|stop-watch>`
 *
 * Replaces the discordx-decorated PictureOnlyChannelCommands class.
 * Configuration is per-channel; the decision to enforce picture-only
 * lives in events/picture-only-channel.events.ts, gated by the
 * guild-level `picture-only` built-in feature toggle.
 */

async function watchChannel(
  command: ChatInputCommandInteraction,
): Promise<void> {
  const existingRecord = await PictureOnlyChannel.findOne({
    where: {
      channelId: command.channelId,
      guildId: command.guildId,
    },
  });
  if (!existingRecord) {
    await PictureOnlyChannel.create({
      channelId: command.channelId,
      guildId: command.guildId,
    });
    await command.reply({
      embeds: [
        {
          color: SUCCEEDED_COLOR,
          title: tForInteraction(command, "common.status.succeeded"),
          description: tForInteraction(command, "picture-only.watch.added"),
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
          description: tForInteraction(command, "picture-only.watch.already"),
        },
      ],
      flags: "Ephemeral",
    });
  }
}

async function stopWatchChannel(
  command: ChatInputCommandInteraction,
): Promise<void> {
  const existingRecord = await PictureOnlyChannel.findOne({
    where: {
      channelId: command.channelId,
      guildId: command.guildId,
    },
  });
  if (existingRecord) {
    await existingRecord.destroy();
    await command.reply({
      embeds: [
        {
          color: SUCCEEDED_COLOR,
          title: tForInteraction(command, "common.status.succeeded"),
          description: tForInteraction(command, "picture-only.watch.removed"),
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
          description: tForInteraction(command, "picture-only.watch.not-watched"),
        },
      ],
      flags: "Ephemeral",
    });
  }
}

export function registerPictureOnlyChannelCommands(): void {
  registerInProcessCommand({
    data: {
      type: ApplicationCommandType.ChatInput,
      name: "picture-only-channel",
      description: describeEn("picture-only.command.description"),
      descriptionLocalizations: localizedDescriptions(
        "picture-only.command.description",
      ),
      defaultMemberPermissions: PermissionFlagsBits.ManageChannels,
      options: [
        {
          type: ApplicationCommandOptionType.Subcommand,
          name: "watch",
          description: describeEn("picture-only.command.watch-description"),
          descriptionLocalizations: localizedDescriptions(
            "picture-only.command.watch-description",
          ),
        },
        {
          type: ApplicationCommandOptionType.Subcommand,
          name: "stop-watch",
          description: describeEn(
            "picture-only.command.stop-watch-description",
          ),
          descriptionLocalizations: localizedDescriptions(
            "picture-only.command.stop-watch-description",
          ),
        },
      ],
    },
    scope: "guild",
    featureKey: "picture-only",
    handler: async (interaction) => {
      const sub = interaction.options.getSubcommand();
      if (sub === "watch") {
        await watchChannel(interaction);
        return;
      }
      if (sub === "stop-watch") {
        await stopWatchChannel(interaction);
        return;
      }
      await interaction.reply({
        content: tForInteraction(interaction, "common.unknown-subcommand", {
          sub,
        }),
        flags: "Ephemeral",
      });
    },
  });
}

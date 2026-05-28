import {
  ActionRowBuilder,
  ApplicationCommandOptionType,
  ApplicationCommandType,
  type ChatInputCommandInteraction,
  ModalBuilder,
  type ModalSubmitInteraction,
  PermissionFlagsBits,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import { RconForwardChannel } from "./rcon-forward-channel.model.js";
import {
  registerInProcessCommand,
  registerInProcessModal,
} from "../in-process-command-registry.service.js";
import { encryptSecret } from "../../../utils/crypto.js";
import { FAILED_COLOR, SUCCEEDED_COLOR } from "../../../utils/constant.js";
import { moduleLogger } from "../../../logger.js";
import {
  describeEn,
  localizedDescriptions,
  resolveLocale,
  t,
  tForInteraction,
  type SupportedLocale,
} from "../../../i18n/index.js";

const log = moduleLogger("rcon-forward-commands");

const MODAL_CUSTOM_ID = "NewRconForwardChannelForm";

/**
 * `/rcon-forward-channel <watch|stop-watch|status|edit>`
 *
 * Replaces the discordx-decorated RconForwardChannelCommands class.
 * `watch` and `edit` open a modal whose submit is routed via the
 * in-process modal registry (customId prefix = MODAL_CUSTOM_ID).
 */

function buildModal(
  locale: SupportedLocale,
  prefill?: {
    host: string;
    port: string;
    triggerPrefix: string;
    commandPrefix: string;
    passwordOptional?: boolean;
  },
): ModalBuilder {
  const modal = new ModalBuilder()
    .setTitle(t(locale, "rcon.modal.title"))
    .setCustomId(MODAL_CUSTOM_ID);
  const host = new TextInputBuilder()
    .setCustomId("fieldHost")
    .setLabel(t(locale, "rcon.modal.host-label"))
    .setStyle(TextInputStyle.Short)
    .setMinLength(1)
    .setMaxLength(300);
  if (prefill?.host) host.setValue(prefill.host);
  const password = new TextInputBuilder()
    .setCustomId("fieldPassword")
    .setLabel(t(locale, "rcon.modal.password-label"))
    .setStyle(TextInputStyle.Short)
    .setMaxLength(300);
  if (prefill?.passwordOptional) {
    password
      .setPlaceholder(t(locale, "rcon.modal.password-placeholder"))
      .setRequired(false);
  } else {
    password.setMinLength(1);
  }
  const port = new TextInputBuilder()
    .setCustomId("fieldPort")
    .setLabel(t(locale, "rcon.modal.port-label"))
    .setStyle(TextInputStyle.Short)
    .setMinLength(1)
    .setMaxLength(5)
    .setValue(prefill?.port ?? "25575");
  const triggerPrefix = new TextInputBuilder()
    .setCustomId("fieldTriggerPrefix")
    .setLabel(t(locale, "rcon.modal.trigger-prefix-label"))
    .setStyle(TextInputStyle.Short)
    .setMinLength(1)
    .setMaxLength(10)
    .setValue(prefill?.triggerPrefix ?? "/");
  const commandPrefix = new TextInputBuilder()
    .setCustomId("fieldCommandPrefix")
    .setLabel(t(locale, "rcon.modal.command-prefix-label"))
    .setStyle(TextInputStyle.Short)
    .setMaxLength(10)
    .setRequired(false)
    .setValue(prefill?.commandPrefix ?? "/");
  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(host),
    new ActionRowBuilder<TextInputBuilder>().addComponents(password),
    new ActionRowBuilder<TextInputBuilder>().addComponents(port),
    new ActionRowBuilder<TextInputBuilder>().addComponents(triggerPrefix),
    new ActionRowBuilder<TextInputBuilder>().addComponents(commandPrefix),
  );
  return modal;
}

async function watchChannel(
  command: ChatInputCommandInteraction,
): Promise<void> {
  const existingRecord = await RconForwardChannel.findOne({
    where: { channelId: command.channelId, guildId: command.guildId },
  });
  if (!existingRecord) {
    await command.showModal(buildModal(resolveLocale(command)));
  } else {
    await command.reply({
      embeds: [
        {
          color: SUCCEEDED_COLOR,
          title: tForInteraction(command, "common.status.no-action"),
          description: tForInteraction(command, "rcon.watch.already"),
        },
      ],
      flags: "Ephemeral",
    });
  }
}

async function stopWatchChannel(
  command: ChatInputCommandInteraction,
): Promise<void> {
  const existingRecord = await RconForwardChannel.findOne({
    where: { channelId: command.channelId, guildId: command.guildId },
  });
  if (existingRecord) {
    await existingRecord.destroy();
    await command.reply({
      embeds: [
        {
          color: SUCCEEDED_COLOR,
          title: tForInteraction(command, "common.status.succeeded"),
          description: tForInteraction(command, "rcon.watch.removed"),
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
          description: tForInteraction(command, "rcon.watch.not-watched"),
        },
      ],
      flags: "Ephemeral",
    });
  }
}

async function status(command: ChatInputCommandInteraction): Promise<void> {
  const existingRecord = await RconForwardChannel.findOne({
    where: { channelId: command.channelId, guildId: command.guildId },
  });
  if (existingRecord) {
    await replyStatus(
      command,
      existingRecord.getDataValue("triggerPrefix"),
      existingRecord.getDataValue("commandPrefix"),
      existingRecord.getDataValue("host"),
      existingRecord.getDataValue("port").toString(),
    );
  } else {
    await command.reply({
      embeds: [
        {
          color: FAILED_COLOR,
          title: tForInteraction(command, "rcon.watch.not-watched"),
        },
      ],
      flags: "Ephemeral",
    });
  }
}

async function edit(command: ChatInputCommandInteraction): Promise<void> {
  const existingRecord = await RconForwardChannel.findOne({
    where: { channelId: command.channelId, guildId: command.guildId },
  });
  if (existingRecord) {
    await command.showModal(
      buildModal(resolveLocale(command), {
        host: existingRecord.getDataValue("host"),
        port: existingRecord.getDataValue("port").toString(),
        triggerPrefix: existingRecord.getDataValue("triggerPrefix"),
        commandPrefix: existingRecord.getDataValue("commandPrefix"),
        passwordOptional: true,
      }),
    );
  } else {
    await command.reply({
      embeds: [
        {
          color: FAILED_COLOR,
          title: tForInteraction(command, "rcon.watch.not-watched"),
        },
      ],
      flags: "Ephemeral",
    });
  }
}

async function replyStatus(
  interaction: ChatInputCommandInteraction | ModalSubmitInteraction,
  triggerPrefix: string,
  commandPrefix: string,
  host: string,
  port: string,
): Promise<void> {
  await interaction.reply({
    flags: "Ephemeral",
    embeds: [
      {
        color: SUCCEEDED_COLOR,
        fields: [
          {
            name: tForInteraction(interaction, "rcon.status.trigger-prefix"),
            value: triggerPrefix,
          },
          {
            name: tForInteraction(interaction, "rcon.status.command-prefix"),
            value: commandPrefix,
          },
          {
            name: tForInteraction(interaction, "rcon.status.host"),
            value: host,
          },
          {
            name: tForInteraction(interaction, "rcon.status.port"),
            value: port,
          },
          {
            name: tForInteraction(interaction, "rcon.status.password"),
            value: "••••••••",
          },
        ],
      },
    ],
  });
}

async function handleModalSubmit(
  interaction: ModalSubmitInteraction,
): Promise<void> {
  try {
    const [triggerPrefix, commandPrefix, host, portString, password] = [
      "fieldTriggerPrefix",
      "fieldCommandPrefix",
      "fieldHost",
      "fieldPort",
      "fieldPassword",
    ].map((id) => interaction.fields.getTextInputValue(id));

    const existingRecord = await RconForwardChannel.findOne({
      where: {
        channelId: interaction.channelId,
        guildId: interaction.guildId,
      },
    });

    if (!existingRecord) {
      await RconForwardChannel.create({
        channelId: interaction.channelId,
        guildId: interaction.guildId,
        triggerPrefix,
        commandPrefix,
        host,
        password: encryptSecret(password),
        port: parseInt(portString),
      });
    } else {
      const updates: Record<string, unknown> = {
        triggerPrefix,
        commandPrefix,
        host,
        port: parseInt(portString),
      };
      if (password) {
        updates.password = encryptSecret(password);
      }
      await existingRecord.update(updates);
    }

    await replyStatus(
      interaction,
      triggerPrefix,
      commandPrefix,
      host,
      portString,
    );
  } catch (ex) {
    log.error({ err: ex }, "rcon-forward-channel command error");
  }
}

export function registerRconForwardChannelCommands(): void {
  registerInProcessCommand({
    data: {
      type: ApplicationCommandType.ChatInput,
      name: "rcon-forward-channel",
      description: describeEn("rcon.command.description"),
      descriptionLocalizations: localizedDescriptions("rcon.command.description"),
      defaultMemberPermissions: PermissionFlagsBits.ManageChannels,
      options: [
        {
          type: ApplicationCommandOptionType.Subcommand,
          name: "watch",
          description: describeEn("rcon.command.watch-description"),
          descriptionLocalizations: localizedDescriptions(
            "rcon.command.watch-description",
          ),
        },
        {
          type: ApplicationCommandOptionType.Subcommand,
          name: "stop-watch",
          description: describeEn("rcon.command.stop-watch-description"),
          descriptionLocalizations: localizedDescriptions(
            "rcon.command.stop-watch-description",
          ),
        },
        {
          type: ApplicationCommandOptionType.Subcommand,
          name: "status",
          description: describeEn("rcon.command.status-description"),
          descriptionLocalizations: localizedDescriptions(
            "rcon.command.status-description",
          ),
        },
        {
          type: ApplicationCommandOptionType.Subcommand,
          name: "edit",
          description: describeEn("rcon.command.edit-description"),
          descriptionLocalizations: localizedDescriptions(
            "rcon.command.edit-description",
          ),
        },
      ],
    },
    scope: "guild",
    featureKey: "rcon",
    handler: async (interaction) => {
      const sub = interaction.options.getSubcommand();
      if (sub === "watch") return watchChannel(interaction);
      if (sub === "stop-watch") return stopWatchChannel(interaction);
      if (sub === "status") return status(interaction);
      if (sub === "edit") return edit(interaction);
      await interaction.reply({
        content: tForInteraction(interaction, "common.unknown-subcommand", {
          sub,
        }),
        flags: "Ephemeral",
      });
    },
  });
  registerInProcessModal({
    prefix: MODAL_CUSTOM_ID,
    handler: handleModalSubmit,
  });
}

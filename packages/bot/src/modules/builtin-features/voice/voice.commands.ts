import {
  ApplicationCommandOptionType,
  ApplicationCommandType,
  PermissionFlagsBits,
  type ChatInputCommandInteraction,
  type GuildMember,
} from "discord.js";
import { registerInProcessCommand } from "../in-process-command-registry.service.js";
import {
  joinVoice,
  leaveVoice,
  playUrl,
  stopPlayback,
  getStatus,
  VoiceCapacityError,
} from "../../voice/voice-manager.service.js";
import { FAILED_COLOR, SUCCEEDED_COLOR } from "../../../utils/constant.js";
import {
  describeEn,
  localizedDescriptions,
  tForInteraction,
} from "../../../i18n/index.js";

function ephemeralReplyError(
  command: ChatInputCommandInteraction,
  msg: string,
): Promise<unknown> {
  return command.reply({
    embeds: [{ description: msg, color: FAILED_COLOR }],
    flags: "Ephemeral",
  });
}

function ephemeralReplyOk(
  command: ChatInputCommandInteraction,
  msg: string,
): Promise<unknown> {
  return command.reply({
    embeds: [{ description: msg, color: SUCCEEDED_COLOR }],
    flags: "Ephemeral",
  });
}

async function handleJoin(command: ChatInputCommandInteraction): Promise<void> {
  if (!command.guildId || !command.guild) {
    await ephemeralReplyError(
      command,
      tForInteraction(command, "voice.guild-only"),
    );
    return;
  }
  const member = command.member as GuildMember | null;
  const voiceChannelId = member?.voice.channelId ?? null;
  if (!voiceChannelId) {
    await ephemeralReplyError(
      command,
      tForInteraction(command, "voice.no-voice-channel"),
    );
    return;
  }
  await command.deferReply({ flags: "Ephemeral" });
  let status;
  try {
    status = await joinVoice({
      guildId: command.guildId,
      channelId: voiceChannelId,
      adapterCreator: command.guild.voiceAdapterCreator,
    });
  } catch (err) {
    if (err instanceof VoiceCapacityError) {
      await command.editReply({
        embeds: [
          {
            description: tForInteraction(command, "voice.cap-reached"),
            color: FAILED_COLOR,
          },
        ],
      });
      return;
    }
    throw err;
  }
  await command.editReply({
    embeds: [
      {
        description: status.connected
          ? tForInteraction(command, "voice.joined", {
              channelId: voiceChannelId,
            })
          : tForInteraction(command, "voice.connection-status", {
              status: status.connectionStatus ?? "unknown",
            }),
        color: status.connected ? SUCCEEDED_COLOR : FAILED_COLOR,
      },
    ],
  });
}

async function handleLeave(
  command: ChatInputCommandInteraction,
): Promise<void> {
  if (!command.guildId) {
    await ephemeralReplyError(
      command,
      tForInteraction(command, "voice.guild-only"),
    );
    return;
  }
  leaveVoice(command.guildId);
  await ephemeralReplyOk(command, tForInteraction(command, "voice.left"));
}

async function handlePlay(command: ChatInputCommandInteraction): Promise<void> {
  if (!command.guildId) {
    await ephemeralReplyError(
      command,
      tForInteraction(command, "voice.guild-only"),
    );
    return;
  }
  const url = command.options.getString("url", true).trim();
  // Reject anything that doesn't parse as http(s); ffmpeg accepts a
  // wider range (file://, rtmp://, etc.) but those are footguns from
  // a slash command. Plugins that want richer formats can use the
  // RPC path with their own validation.
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    await ephemeralReplyError(
      command,
      tForInteraction(command, "voice.bad-url"),
    );
    return;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    await ephemeralReplyError(
      command,
      tForInteraction(command, "voice.http-only"),
    );
    return;
  }
  try {
    const status = playUrl(command.guildId, url);
    await ephemeralReplyOk(
      command,
      tForInteraction(command, "voice.playing", {
        url,
        playerStatus: status.playerStatus ?? "",
      }),
    );
  } catch (err) {
    if (err instanceof Error && err.message === "not_joined") {
      await ephemeralReplyError(
        command,
        tForInteraction(command, "voice.not-joined"),
      );
      return;
    }
    if (err instanceof Error && err.message === "ffmpeg_not_available") {
      await ephemeralReplyError(
        command,
        tForInteraction(command, "voice.ffmpeg-missing"),
      );
      return;
    }
    throw err;
  }
}

async function handleStop(command: ChatInputCommandInteraction): Promise<void> {
  if (!command.guildId) {
    await ephemeralReplyError(
      command,
      tForInteraction(command, "voice.guild-only"),
    );
    return;
  }
  stopPlayback(command.guildId);
  await ephemeralReplyOk(command, tForInteraction(command, "voice.stopped"));
}

async function handleStatus(
  command: ChatInputCommandInteraction,
): Promise<void> {
  if (!command.guildId) {
    await ephemeralReplyError(
      command,
      tForInteraction(command, "voice.guild-only"),
    );
    return;
  }
  const status = getStatus(command.guildId);
  const yes = tForInteraction(command, "voice.status-lines.yes");
  const no = tForInteraction(command, "voice.status-lines.no");
  const noneLabel = tForInteraction(command, "voice.status-lines.channel-none");
  const lines = [
    tForInteraction(command, "voice.status-lines.connected", {
      connected: status.connected ? yes : no,
    }),
    tForInteraction(command, "voice.status-lines.channel", {
      channel: status.channelId ? `<#${status.channelId}>` : noneLabel,
    }),
    tForInteraction(command, "voice.status-lines.playing", {
      playing: status.playing ? yes : no,
    }),
    status.playingUrl
      ? tForInteraction(command, "voice.status-lines.playing-url", {
          url: status.playingUrl,
        })
      : null,
    tForInteraction(command, "voice.status-lines.connection", {
      status: status.connectionStatus ?? noneLabel,
    }),
    tForInteraction(command, "voice.status-lines.player", {
      status: status.playerStatus ?? noneLabel,
    }),
  ].filter(Boolean);
  await command.reply({
    embeds: [{ description: lines.join("\n"), color: SUCCEEDED_COLOR }],
    flags: "Ephemeral",
  });
}

export function registerVoiceCommands(): void {
  registerInProcessCommand({
    data: {
      type: ApplicationCommandType.ChatInput,
      name: "voice",
      description: describeEn("voice.command.description"),
      descriptionLocalizations: localizedDescriptions(
        "voice.command.description",
      ),
      defaultMemberPermissions: PermissionFlagsBits.ManageGuild,
      options: [
        {
          type: ApplicationCommandOptionType.Subcommand,
          name: "join",
          description: describeEn("voice.command.join-description"),
          descriptionLocalizations: localizedDescriptions(
            "voice.command.join-description",
          ),
        },
        {
          type: ApplicationCommandOptionType.Subcommand,
          name: "leave",
          description: describeEn("voice.command.leave-description"),
          descriptionLocalizations: localizedDescriptions(
            "voice.command.leave-description",
          ),
        },
        {
          type: ApplicationCommandOptionType.Subcommand,
          name: "play",
          description: describeEn("voice.command.play-description"),
          descriptionLocalizations: localizedDescriptions(
            "voice.command.play-description",
          ),
          options: [
            {
              type: ApplicationCommandOptionType.String,
              name: "url",
              description: describeEn("voice.option.play-url"),
              descriptionLocalizations: localizedDescriptions(
                "voice.option.play-url",
              ),
              required: true,
            },
          ],
        },
        {
          type: ApplicationCommandOptionType.Subcommand,
          name: "stop",
          description: describeEn("voice.command.stop-description"),
          descriptionLocalizations: localizedDescriptions(
            "voice.command.stop-description",
          ),
        },
        {
          type: ApplicationCommandOptionType.Subcommand,
          name: "status",
          description: describeEn("voice.command.status-description"),
          descriptionLocalizations: localizedDescriptions(
            "voice.command.status-description",
          ),
        },
      ],
    },
    scope: "guild",
    featureKey: "voice",
    handler: async (interaction) => {
      const sub = interaction.options.getSubcommand();
      if (sub === "join") return handleJoin(interaction);
      if (sub === "leave") return handleLeave(interaction);
      if (sub === "play") return handlePlay(interaction);
      if (sub === "stop") return handleStop(interaction);
      if (sub === "status") return handleStatus(interaction);
      await interaction.reply({
        content: tForInteraction(interaction, "common.unknown-subcommand", {
          sub,
        }),
        flags: "Ephemeral",
      });
    },
  });
}

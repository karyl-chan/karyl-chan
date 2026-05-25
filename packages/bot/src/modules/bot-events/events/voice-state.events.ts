import {
  ChannelType,
  type Client,
  type GuildMember,
  type VoiceBasedChannel,
} from "discord.js";
import {
  guildChannelEventBus,
  type VoiceMember,
} from "../../guild-management/guild-channel-event-bus.js";
import {
  avatarUrlFor,
  guildAvatarUrlFor,
} from "../../web-core/message-mapper.js";
import { dispatchEventToPlugins } from "../../plugin-system/plugin-event-bridge.service.js";
import { moduleLogger } from "../../../logger.js";

const log = moduleLogger("voice-state");

function memberRow(guildId: string, m: GuildMember): VoiceMember {
  return {
    id: m.id,
    username: m.user.username,
    globalName: m.user.globalName ?? null,
    nickname: m.nickname ?? null,
    avatarUrl: m.avatar
      ? guildAvatarUrlFor(guildId, m.id, m.avatar, 64)
      : avatarUrlFor(m.id, m.user.avatar, 64),
  };
}

function channelMembers(channel: VoiceBasedChannel): {
  channelId: string;
  members: VoiceMember[];
} {
  return {
    channelId: channel.id,
    members: [...channel.members.values()].map((m) =>
      memberRow(channel.guildId, m),
    ),
  };
}

export function registerVoiceStateEvents(client: Client): void {
  client.on("voiceStateUpdate", (oldState, newState) => {
    // Only join / leave / move are relevant to the participant list —
    // mute / deafen / video toggles fire the same gateway event but
    // don't change membership, so we filter them out here.
    if (oldState.channelId === newState.channelId) return;

    const guildId = newState.guild.id;
    const affected: Array<{ channelId: string; members: VoiceMember[] }> = [];
    const seen = new Set<string>();

    for (const ch of [oldState.channel, newState.channel]) {
      if (!ch) continue;
      if (
        ch.type !== ChannelType.GuildVoice &&
        ch.type !== ChannelType.GuildStageVoice
      ) {
        continue;
      }
      if (seen.has(ch.id)) continue;
      seen.add(ch.id);
      affected.push(channelMembers(ch));
    }
    if (affected.length === 0) return;

    try {
      guildChannelEventBus.publish({
        type: "guild-voice-state-updated",
        guildId,
        channels: affected,
      });
    } catch (err) {
      log.error({ err }, "voice-state publish failed");
    }

    // Fan out to plugins that subscribed to `guild.voice_state_update`.
    // Payload is intentionally minimal — plugins can call voice.status
    // / users.get for richer data on demand. `in_voice` is convenient
    // so a plugin doesn't have to reason about the null channel ids.
    const memberUser = newState.member?.user;
    try {
      dispatchEventToPlugins("guild.voice_state_update", {
        guild_id: guildId,
        user: {
          id: newState.member?.id ?? newState.id,
          username: memberUser?.username ?? null,
          global_name: memberUser?.globalName ?? null,
        },
        old_channel_id: oldState.channelId ?? null,
        new_channel_id: newState.channelId ?? null,
        in_voice: newState.channelId !== null,
      });
    } catch (err) {
      log.error({ err }, "voice-state plugin fan-out failed");
    }
  });
}

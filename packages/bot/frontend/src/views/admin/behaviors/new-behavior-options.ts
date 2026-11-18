import type { BehaviorAudienceKind, BehaviorTargetView } from '../../../api/behavior';
import type { LocationKind } from './message-trigger-location';

/**
 * What "new behavior" may create in a Behavior Target (ADR 0003: adding
 * somewhere only offers what it can hold; ADR 0004: the somewhere is a
 * target), and why the rest is not offered — reasons are i18n keys, shown
 * next to the disabled choice (board 2).
 *
 *   - App 指令: commands only — the bot cannot read messages between
 *     users or in servers it is not in.
 *   - 所有人與 bot 的私訊: commands, and message triggers in bot DMs.
 *   - 全部伺服器 / one server: commands, and message triggers there; from
 *     all servers a trigger may still be narrowed to one server or channel.
 *   - one channel: message triggers only — Discord cannot limit a command
 *     to one channel.
 *   - one user / one group: message triggers in bot DMs for that user or
 *     group only — a command has no audience: whoever sees it can run it.
 *
 * This only says whether the target can hold a command; the visibility a
 * new one starts with is command-draft.ts `newCommandVisibility`.
 */
export interface KindOption {
    possible: boolean;
    reason: string | null;
}

/** Who a new message trigger is for. */
export interface NewTriggerAudience {
    kind: BehaviorAudienceKind;
    userId: string;
    groupName: string;
}

export interface MessageOption extends KindOption {
    /** The locations a new trigger may be at; the first is the default. */
    locations: LocationKind[];
    /** The target fixes the server. */
    lockGuild: boolean;
    /** The target fixes the channel. */
    lockChannel: boolean;
    guildId: string;
    channelId: string;
    /** The audience a new trigger starts with: the target's user or group, else everyone. */
    audience: NewTriggerAudience;
}

export interface NewBehaviorOptions {
    command: KindOption;
    message: MessageOption;
}

const yes: KindOption = { possible: true, reason: null };
const EVERYONE: NewTriggerAudience = { kind: 'all', userId: '', groupName: '' };

export function newBehaviorOptions(target: BehaviorTargetView): NewBehaviorOptions {
    const message = (locations: LocationKind[], extra: Partial<MessageOption> = {}): MessageOption => ({
        possible: true,
        reason: null,
        locations,
        lockGuild: false,
        lockChannel: false,
        guildId: '',
        channelId: '',
        audience: EVERYONE,
        ...extra,
    });
    const guildId = target.guildId ?? '';
    switch (target.kind) {
        case 'app':
            return {
                command: yes,
                message: { ...message([]), possible: false, reason: 'behaviors.add.reason.messageInApp' },
            };
        case 'bot_dm':
            return { command: yes, message: message(['bot_dm']) };
        case 'guild_all':
            return { command: yes, message: message(['guild_all', 'guild', 'channel']) };
        case 'guild':
            return { command: yes, message: message(['guild', 'channel'], { lockGuild: true, guildId }) };
        case 'channel':
            return {
                command: { possible: false, reason: 'behaviors.add.reason.commandInChannel' },
                message: message(['channel'], {
                    lockGuild: true,
                    lockChannel: true,
                    guildId,
                    channelId: target.channelId ?? '',
                }),
            };
        case 'user':
            return {
                command: { possible: false, reason: 'behaviors.add.reason.commandNeedsEveryone' },
                message: message(['bot_dm'], {
                    audience: { kind: 'user', userId: target.userId ?? '', groupName: '' },
                }),
            };
        case 'group':
            return {
                command: { possible: false, reason: 'behaviors.add.reason.commandNeedsEveryone' },
                message: message(['bot_dm'], {
                    audience: { kind: 'group', userId: '', groupName: target.groupName ?? '' },
                }),
            };
    }
}

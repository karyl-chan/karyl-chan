import type { BehaviorSection } from '../../../api/behavior';
import { parseSection } from './behavior-sections';
import type { LocationKind } from './message-trigger-location';

/**
 * What "new behavior" may create in a Behavior Section (ADR 0003: adding
 * in a section only offers what that section can hold), and why the rest
 * is not offered — reasons are i18n keys, shown next to the disabled
 * choice (board 2).
 *
 *   - App 指令: commands only — the bot cannot read messages between
 *     users or in servers it is not in.
 *   - 與 bot 的私訊: commands, and message triggers in bot DMs (with an
 *     audience).
 *   - 全部伺服器 / one server: commands, and message triggers there; from
 *     all servers a trigger may still be narrowed to one server or channel.
 *   - one channel: message triggers only — Discord cannot limit a command
 *     to one channel.
 *
 * This only says whether the section can hold a command; the visibility a
 * new one starts with is command-draft.ts `newCommandVisibility`.
 */
export interface KindOption {
    possible: boolean;
    reason: string | null;
}

export interface MessageOption extends KindOption {
    /** The locations a new trigger may be at; the first is the default. */
    locations: LocationKind[];
    /** The section fixes the server. */
    lockGuild: boolean;
    /** The section fixes the channel. */
    lockChannel: boolean;
    guildId: string;
    channelId: string;
}

export interface NewBehaviorOptions {
    command: KindOption;
    message: MessageOption;
}

const yes: KindOption = { possible: true, reason: null };

export function newBehaviorOptions(section: BehaviorSection): NewBehaviorOptions {
    const s = parseSection(section);
    const message = (locations: LocationKind[], extra: Partial<MessageOption> = {}): MessageOption => ({
        possible: true,
        reason: null,
        locations,
        lockGuild: false,
        lockChannel: false,
        guildId: '',
        channelId: '',
        ...extra,
    });
    switch (s.kind) {
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
            return { command: yes, message: message(['guild', 'channel'], { lockGuild: true, guildId: s.guildId }) };
        case 'channel':
            return {
                command: { possible: false, reason: 'behaviors.add.reason.commandInChannel' },
                message: message(['channel'], {
                    lockGuild: true,
                    lockChannel: true,
                    guildId: s.guildId,
                    channelId: s.channelId,
                }),
            };
    }
}

import type { BehaviorSection, MessageTriggerLocation, MessageTriggerView } from '../../../api/behavior';
import { parseSection } from './behavior-sections';

/**
 * Message Trigger Locations (CONTEXT.md) as the UI handles them: a kind
 * plus its ids, never a string to take apart. The key form
 * (`bot_dm`, `guild:all`, `guild:<id>`, `channel:<g>:<c>`) is only built
 * for the reorder API and to compare with a trigger's section.
 */

export type LocationKind = 'bot_dm' | 'guild_all' | 'guild' | 'channel';

export type TriggerLocation =
    | { kind: 'bot_dm' }
    | { kind: 'guild_all' }
    | { kind: 'guild'; guildId: string }
    | { kind: 'channel'; guildId: string; channelId: string };

export function locationKindOf(t: Pick<MessageTriggerView, 'surface' | 'guildId' | 'channelId'>): LocationKind {
    if (t.surface === 'bot_dm') return 'bot_dm';
    if (t.channelId) return 'channel';
    if (t.guildId) return 'guild';
    return 'guild_all';
}

/** One server, or one of its channels: the location names a guild. */
export function kindHasGuild(kind: LocationKind): boolean {
    return kind === 'guild' || kind === 'channel';
}

/**
 * The location a section's message triggers are at — null for App 指令,
 * which holds commands only. A section is presentation; this is the one
 * place it turns into a location (CONTEXT.md: sections are not write units).
 */
export function locationOfSection(section: BehaviorSection): TriggerLocation | null {
    const s = parseSection(section);
    switch (s.kind) {
        case 'app':
            return null;
        case 'guild_all':
            return { kind: 'guild_all' };
        default:
            return s;
    }
}

export function locationKey(loc: TriggerLocation): MessageTriggerLocation {
    switch (loc.kind) {
        case 'bot_dm':
            return 'bot_dm';
        case 'guild_all':
            return 'guild:all';
        case 'guild':
            return `guild:${loc.guildId}`;
        case 'channel':
            return `channel:${loc.guildId}:${loc.channelId}`;
    }
}

/** The Message Trigger Location to reorder in a section; null for App 指令. */
export function messageTriggerLocationOf(section: BehaviorSection): MessageTriggerLocation | null {
    const loc = locationOfSection(section);
    return loc ? locationKey(loc) : null;
}

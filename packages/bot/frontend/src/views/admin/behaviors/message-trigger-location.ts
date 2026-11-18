import type { MessageTriggerLocation, MessageTriggerView } from '../../../api/behavior';

/**
 * Message Trigger Locations (GLOSSARY.md) as the UI handles them: a kind
 * plus its ids, never a string to take apart. The key form
 * (`bot_dm`, `guild:all`, `guild:<id>`, `channel:<g>:<c>`) is only built
 * for a trigger conversion and to compare with a trigger's section.
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

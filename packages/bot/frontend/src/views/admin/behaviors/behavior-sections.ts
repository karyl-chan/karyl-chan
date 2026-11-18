import type { BehaviorItemView, BehaviorSection } from '../../../api/behavior';

/**
 * Behavior Section keys (ADR 0003) as the forms read them: where a command
 * with given visibility lands, where a message trigger is. The server
 * derives each item's `section`; this file only takes those keys apart —
 * it never re-derives a section from trigger fields. (The command form's
 * live "lands in" hint is the one exception: command-rules.ts, a mirror
 * the bot's tests pin to the server's rule.)
 *
 * The page itself groups by Behavior Target: behavior-targets.ts.
 */

export type ParsedSection =
    | { kind: 'app' }
    | { kind: 'bot_dm' }
    | { kind: 'guild_all' }
    | { kind: 'guild'; guildId: string }
    | { kind: 'channel'; guildId: string; channelId: string };

export function parseSection(key: BehaviorSection): ParsedSection {
    if (key === 'app') return { kind: 'app' };
    if (key === 'bot_dm') return { kind: 'bot_dm' };
    if (key === 'guild:all') return { kind: 'guild_all' };
    if (key.startsWith('channel:')) {
        const [, guildId, channelId] = key.split(':');
        return { kind: 'channel', guildId, channelId };
    }
    return { kind: 'guild', guildId: key.slice('guild:'.length) };
}

/** A card's key across the page: commands and behaviors are numbered apart. */
export function itemKey(item: Pick<BehaviorItemView, 'kind' | 'id'>): string {
    return `${item.kind}:${item.id}`;
}

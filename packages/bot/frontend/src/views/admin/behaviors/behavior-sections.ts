import type {
    BehaviorItemView,
    BehaviorListView,
    BehaviorSection,
    CommandView,
    MessageTriggerView,
} from '../../../api/behavior';

/**
 * Grouping of the behaviors page by Behavior Section (ADR 0003). The
 * server derives each item's `section`; this file only reads those keys —
 * it never re-derives a section from trigger fields.
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

const FIXED: BehaviorSection[] = ['app', 'bot_dm', 'guild:all'];

function allItems(view: BehaviorListView): BehaviorItemView[] {
    return [
        ...(view.system ? [view.system] : []),
        ...view.commands,
        ...view.messageTriggers,
    ];
}

/**
 * Sidebar entries: the three fixed sections, then every specific guild
 * that has items (directly or through one of its channels), each followed
 * by its channels.
 */
export function sidebarSections(view: BehaviorListView): BehaviorSection[] {
    const channelsByGuild = new Map<string, Set<string>>();
    for (const item of allItems(view)) {
        const s = parseSection(item.section);
        if (s.kind === 'guild') {
            if (!channelsByGuild.has(s.guildId)) channelsByGuild.set(s.guildId, new Set());
        } else if (s.kind === 'channel') {
            const set = channelsByGuild.get(s.guildId) ?? new Set<string>();
            set.add(s.channelId);
            channelsByGuild.set(s.guildId, set);
        }
    }
    const out: BehaviorSection[] = [...FIXED];
    for (const guildId of [...channelsByGuild.keys()].sort()) {
        out.push(`guild:${guildId}`);
        for (const channelId of [...channelsByGuild.get(guildId)!].sort()) {
            out.push(`channel:${guildId}:${channelId}`);
        }
    }
    return out;
}

export interface SectionItems {
    /** The System Behavior when it lives in this section — pinned on top. */
    system: BehaviorItemView | null;
    commands: CommandView[];
    messageTriggers: MessageTriggerView[];
}

export function itemsInSection(view: BehaviorListView, key: BehaviorSection): SectionItems {
    return {
        system: view.system && view.system.section === key ? view.system : null,
        commands: view.commands.filter((c) => c.section === key),
        messageTriggers: view.messageTriggers.filter((t) => t.section === key),
    };
}

/** Number of behaviors (leaves + triggers) in a section, for the sidebar. */
export function countInSection(view: BehaviorListView, key: BehaviorSection): number {
    const items = itemsInSection(view, key);
    return (
        (items.system ? 1 : 0) +
        items.commands.reduce((n, c) => n + c.leaves.length, 0) +
        items.messageTriggers.length
    );
}

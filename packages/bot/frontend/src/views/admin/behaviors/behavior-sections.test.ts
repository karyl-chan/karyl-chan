import { describe, expect, it } from 'vitest';
import type {
    BehaviorListView,
    CommandView,
    MessageTriggerView,
} from '../../../api/behavior';
import { itemsInSection, parseSection, sidebarSections } from './behavior-sections';

function command(id: number, section: CommandView['section'], name = `cmd${id}`): CommandView {
    return {
        kind: 'command',
        id,
        name,
        description: name,
        registration: 'global',
        guildId: null,
        integrationTypes: ['guild_install'],
        contexts: ['Guild'],
        defaultMemberPermissions: null,
        isSystem: false,
        section,
        leaves: [],
    };
}

function trigger(id: number, section: MessageTriggerView['section']): MessageTriggerView {
    return {
        kind: 'message',
        id,
        title: `t${id}`,
        description: '',
        enabled: true,
        sortOrder: id,
        systemKey: null,
        actionSource: 'webhook',
        webhook: null,
        stats: null,
        surface: section === 'bot_dm' ? 'bot_dm' : 'guild',
        guildId: null,
        channelId: null,
        patternKind: 'startswith',
        patternValue: '!x',
        stopOnMatch: false,
        ignoreBots: true,
        audienceKind: 'all',
        audienceUserId: null,
        audienceGroupName: null,
        section,
    };
}

const login = { ...trigger(100, 'bot_dm'), systemKey: 'admin-login', actionSource: 'builtin' as const };

const view: BehaviorListView = {
    system: login,
    commands: [command(1, 'app'), command(2, 'guild:G2'), command(3, 'guild:all')],
    messageTriggers: [
        trigger(10, 'bot_dm'),
        trigger(11, 'channel:G1:C1'),
        trigger(12, 'guild:G1'),
        trigger(13, 'channel:G1:C0'),
    ],
};

describe('parseSection', () => {
    it('reads every section key', () => {
        expect(parseSection('app')).toEqual({ kind: 'app' });
        expect(parseSection('bot_dm')).toEqual({ kind: 'bot_dm' });
        expect(parseSection('guild:all')).toEqual({ kind: 'guild_all' });
        expect(parseSection('guild:123')).toEqual({ kind: 'guild', guildId: '123' });
        expect(parseSection('channel:123:456')).toEqual({
            kind: 'channel',
            guildId: '123',
            channelId: '456',
        });
    });
});

describe('sidebarSections', () => {
    it('always lists the fixed sections, then guilds with their channels', () => {
        expect(sidebarSections(view)).toEqual([
            'app',
            'bot_dm',
            'guild:all',
            'guild:G1',
            'channel:G1:C0',
            'channel:G1:C1',
            'guild:G2',
        ]);
    });

    it('lists a channel section even when its guild has no own items', () => {
        const only: BehaviorListView = {
            system: null,
            commands: [],
            messageTriggers: [trigger(1, 'channel:G9:C9')],
        };
        expect(sidebarSections(only)).toEqual([
            'app',
            'bot_dm',
            'guild:all',
            'guild:G9',
            'channel:G9:C9',
        ]);
    });
});

describe('itemsInSection', () => {
    it('pins the system behavior at the top of its own section', () => {
        const dm = itemsInSection(view, 'bot_dm');
        expect(dm.system?.id).toBe(100);
        expect(dm.messageTriggers.map((t) => t.id)).toEqual([10]);
        expect(dm.commands).toEqual([]);
    });

    it('keeps the system behavior out of other sections', () => {
        expect(itemsInSection(view, 'app').system).toBeNull();
    });

    it('groups commands and triggers by exact section', () => {
        expect(itemsInSection(view, 'guild:G1').messageTriggers.map((t) => t.id)).toEqual([12]);
        expect(itemsInSection(view, 'channel:G1:C1').messageTriggers.map((t) => t.id)).toEqual([11]);
        expect(itemsInSection(view, 'guild:G2').commands.map((c) => c.id)).toEqual([2]);
        expect(itemsInSection(view, 'guild:all').commands.map((c) => c.id)).toEqual([3]);
    });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BehaviorListView, MessageTriggerView } from '../../../api/behavior';

const listMock = vi.hoisted(() => vi.fn());
vi.mock('../../../api/behavior', () => ({
    listBehaviors: (...args: unknown[]) => listMock(...args),
}));

import { useBehaviorList } from './use-behavior-list';

const GUILD = '123456789012345678';

function trigger(id: number, overrides: Partial<MessageTriggerView> = {}): MessageTriggerView {
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
        updatedAt: '2026-10-27T00:00:00.000Z',
        surface: 'bot_dm',
        guildId: null,
        channelId: null,
        patternKind: 'startswith',
        patternValue: `!${id}`,
        stopOnMatch: false,
        ignoreBots: true,
        audienceKind: 'all',
        audienceUserId: null,
        audienceGroupName: null,
        section: 'bot_dm',
        ...overrides,
    };
}

function list(messageTriggers: MessageTriggerView[]): BehaviorListView {
    return { system: null, commands: [], messageTriggers };
}

beforeEach(() => {
    listMock.mockReset();
});

describe('useBehaviorList', () => {
    it('takes a saved trigger in place, staying in the section', async () => {
        listMock.mockResolvedValue(list([trigger(1), trigger(2)]));
        const state = useBehaviorList();
        await state.load();
        state.selected.value = 'bot_dm';

        await state.applyTrigger(trigger(2, { title: 'renamed' }));
        expect(state.view.value?.messageTriggers.map((m) => m.title)).toEqual(['t1', 'renamed']);
        expect(state.selected.value).toBe('bot_dm');
        expect(state.expandId.value).toBeNull();
    });

    it('follows a trigger that moved to another section and opens it', async () => {
        listMock.mockResolvedValue(list([trigger(1)]));
        const state = useBehaviorList();
        await state.load();

        state.selected.value = 'bot_dm';
        await state.applyTrigger(trigger(1, { surface: 'guild', guildId: GUILD, section: `guild:${GUILD}` }));
        expect(state.selected.value).toBe(`guild:${GUILD}`);
        expect(state.sections.value).toContain(`guild:${GUILD}`);
        expect(state.expandId.value).toBe(1);
    });

    it('counts the triggers using each audience group', async () => {
        listMock.mockResolvedValue(
            list([
                trigger(1, { audienceKind: 'group', audienceGroupName: 'ops' }),
                trigger(2, { audienceKind: 'group', audienceGroupName: 'ops' }),
                trigger(3, { audienceKind: 'group', audienceGroupName: 'vip' }),
                trigger(4),
            ])
        );
        const state = useBehaviorList();
        await state.load();
        expect([...state.groupUse.value]).toEqual([
            ['ops', 2],
            ['vip', 1],
        ]);
    });
});

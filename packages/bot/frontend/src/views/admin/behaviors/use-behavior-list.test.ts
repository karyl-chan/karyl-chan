import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BehaviorListView, MessageTriggerView } from '../../../api/behavior';

const listMock = vi.hoisted(() => vi.fn());
const reorderMock = vi.hoisted(() => vi.fn());
vi.mock('../../../api/behavior', () => ({
    listBehaviors: (...args: unknown[]) => listMock(...args),
    reorderMessageTriggers: (...args: unknown[]) => reorderMock(...args),
}));

import { ApiError } from '../../../api/client';
import { useBehaviorList } from './use-behavior-list';
import { savedCommand } from './behavior-test-support';

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
    reorderMock.mockReset();
});

describe('useBehaviorList — commands', () => {
    it('takes a command the server answered with in place', async () => {
        const command = savedCommand();
        listMock.mockResolvedValue({ system: null, commands: [command, savedCommand({ id: 5, name: 'other' })], messageTriggers: [] });
        const state = useBehaviorList();
        await state.load();
        await state.applyCommand(savedCommand({ description: 'Resynced' }));
        expect(state.view.value?.commands.map((c) => c.description)).toEqual(['Resynced', 'Service status']);
        expect(state.expandKey.value).toBeNull();
    });

    it('follows a command whose visibility moved it to another section, and opens it', async () => {
        listMock.mockResolvedValue({ system: null, commands: [savedCommand()], messageTriggers: [] });
        const state = useBehaviorList();
        await state.load();
        state.selected.value = 'bot_dm';
        await state.applyCommand(savedCommand({ integrationTypes: ['guild_install', 'user_install'], section: 'app' }));
        expect(state.selected.value).toBe('app');
        expect(state.expandKey.value).toBe('command:4');
    });

    it('a created command is listed and opened where it lives', async () => {
        const created = savedCommand({ id: 9, section: 'app' });
        listMock.mockResolvedValue({ system: null, commands: [created], messageTriggers: [] });
        const state = useBehaviorList();
        state.selected.value = 'bot_dm';
        await state.showCreated(created);
        expect(state.selected.value).toBe('app');
        expect(state.expandKey.value).toBe('command:9');
    });
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
        expect(state.expandKey.value).toBeNull();
    });

    it('follows a trigger that moved to another section and opens it', async () => {
        listMock.mockResolvedValue(list([trigger(1)]));
        const state = useBehaviorList();
        await state.load();

        state.selected.value = 'bot_dm';
        await state.applyTrigger(trigger(1, { surface: 'guild', guildId: GUILD, section: `guild:${GUILD}` }));
        expect(state.selected.value).toBe(`guild:${GUILD}`);
        expect(state.sections.value).toContain(`guild:${GUILD}`);
        expect(state.expandKey.value).toBe('message:1');
    });

    it('stays put when leaving would drop drafts and the admin says no', async () => {
        listMock.mockResolvedValue(list([trigger(1)]));
        const state = useBehaviorList();
        await state.load();
        state.selected.value = 'bot_dm';
        const mayLeave = vi.fn(async () => false);

        await state.applyTrigger(trigger(1, { surface: 'guild', section: 'guild:all' }), mayLeave);
        expect(mayLeave).toHaveBeenCalledTimes(1);
        expect(state.selected.value).toBe('bot_dm');
        expect(state.view.value?.messageTriggers[0].section).toBe('guild:all');
    });

    it('after a create, reloads the list and opens the new card where it lives (#104)', async () => {
        listMock.mockResolvedValueOnce(list([trigger(1)]));
        const state = useBehaviorList();
        await state.load();
        state.selected.value = 'guild:all';

        const created = trigger(2, { surface: 'guild', guildId: GUILD, section: `guild:${GUILD}` });
        listMock.mockResolvedValueOnce(list([trigger(1), created]));
        await state.showCreated(created);

        expect(listMock).toHaveBeenCalledTimes(2);
        expect(state.view.value?.messageTriggers.map((m) => m.id)).toEqual([1, 2]);
        expect(state.selected.value).toBe(`guild:${GUILD}`);
        expect(state.expandKey.value).toBe('message:2');
    });

    it('after a create elsewhere, asks before leaving a section with drafts', async () => {
        listMock.mockResolvedValue(list([trigger(1)]));
        const state = useBehaviorList();
        await state.load();
        state.selected.value = 'bot_dm';
        const mayLeave = vi.fn(async () => false);

        await state.showCreated(trigger(2, { surface: 'guild', section: 'guild:all' }), mayLeave);
        expect(mayLeave).toHaveBeenCalledTimes(1);
        expect(state.selected.value).toBe('bot_dm');
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

describe('useBehaviorList — reordering a location', () => {
    const guildAll = (id: number) => trigger(id, { surface: 'guild', section: 'guild:all' });

    it('shows the new order at once and sends it for that location only', async () => {
        listMock.mockResolvedValue(list([trigger(1), guildAll(2), trigger(3), trigger(4)]));
        reorderMock.mockResolvedValue({ location: 'bot_dm', ids: [4, 1, 3] });
        const state = useBehaviorList();
        await state.load();

        await state.reorder('bot_dm', [4, 1, 3]);
        expect(reorderMock).toHaveBeenCalledWith('bot_dm', [4, 1, 3]);
        // the other location's trigger keeps its place in the list
        expect(state.view.value?.messageTriggers.map((m) => m.id)).toEqual([4, 2, 1, 3]);
        expect(listMock).toHaveBeenCalledTimes(1);
    });

    it('a stale order reloads the list and reports the refusal', async () => {
        listMock.mockResolvedValue(list([trigger(1), trigger(3)]));
        const stale = new ApiError(409, 'the triggers at bot_dm changed', 'validation_failed', 'ids');
        reorderMock.mockRejectedValue(stale);
        const state = useBehaviorList();
        await state.load();

        await expect(state.reorder('bot_dm', [3, 1])).rejects.toBe(stale);
        expect(listMock).toHaveBeenCalledTimes(2);
        expect(state.view.value?.messageTriggers.map((m) => m.id)).toEqual([1, 3]);
    });
});

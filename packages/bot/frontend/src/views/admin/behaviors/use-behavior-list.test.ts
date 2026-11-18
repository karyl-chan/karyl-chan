import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BehaviorListView, BehaviorTargetView, MessageTriggerView } from '../../../api/behavior';

const listMock = vi.hoisted(() => vi.fn());
const reorderMock = vi.hoisted(() => vi.fn());
vi.mock('../../../api/behavior', () => ({
    listBehaviors: (...args: unknown[]) => listMock(...args),
    reorderMessageTriggers: (...args: unknown[]) => reorderMock(...args),
}));

import { ApiError } from '../../../api/client';
import { useBehaviorList } from './use-behavior-list';
import {
    BUILTIN_TARGETS,
    builtinTarget,
    createdTarget,
    savedCommand,
    savedTrigger,
    systemLoginCommand,
    systemLoginMessage,
} from './behavior-test-support';

const GUILD = '123456789012345678';
const USER = '323456789012345678';

const guild = createdTarget(`guild:${GUILD}`);
const user = createdTarget(`user:${USER}`);
const TARGETS: BehaviorTargetView[] = [...BUILTIN_TARGETS, guild, user];

function trigger(id: number, overrides: Partial<MessageTriggerView> = {}): MessageTriggerView {
    return savedTrigger({ id, title: `t${id}`, sortOrder: id, webhook: null, patternValue: `!${id}`, ...overrides });
}
/** A trigger in the server GUILD. */
const inGuild = (id: number) =>
    trigger(id, { surface: 'guild', guildId: GUILD, target: `guild:${GUILD}`, section: `guild:${GUILD}` });
/** A trigger in all servers. */
const inAllGuilds = (id: number) => trigger(id, { surface: 'guild', target: 'guild:all', section: 'guild:all' });
/** A bot DM trigger for USER. */
const forUser = (id: number) =>
    trigger(id, { audienceKind: 'user', audienceUserId: USER, target: `user:${USER}` });

function list(messageTriggers: MessageTriggerView[], more: Partial<BehaviorListView> = {}): BehaviorListView {
    return { targets: TARGETS, system: null, services: [], commands: [], messageTriggers, ...more };
}

beforeEach(() => {
    listMock.mockReset();
    reorderMock.mockReset();
});

describe('useBehaviorList — the selected target', () => {
    it('lands on the target the login lives in', async () => {
        listMock.mockResolvedValue(list([], { system: systemLoginMessage() }));
        const state = useBehaviorList();
        await state.load();
        expect(state.selected.value).toBe('bot_dm');
        expect(state.selectedTarget.value).toEqual(builtinTarget('bot_dm'));
        expect(state.targets.value.map((t) => t.key)).toEqual(TARGETS.map((t) => t.key));
    });

    it('keeps the selection across a reload, and falls back when its target is gone', async () => {
        listMock.mockResolvedValue(list([]));
        const state = useBehaviorList();
        await state.load();
        state.selected.value = `guild:${GUILD}`;
        await state.load();
        expect(state.selected.value).toBe(`guild:${GUILD}`);

        // the target was deleted
        listMock.mockResolvedValue({ ...list([]), targets: BUILTIN_TARGETS });
        await state.load();
        expect(state.selected.value).toBe('app');
    });
});

describe('useBehaviorList — commands', () => {
    it('takes a command the server answered with in place', async () => {
        const command = savedCommand();
        listMock.mockResolvedValue(list([], { commands: [command, savedCommand({ id: 5, name: 'other' })] }));
        const state = useBehaviorList();
        await state.load();
        await state.applyCommand(savedCommand({ description: 'Resynced' }));
        expect(state.view.value?.commands.map((c) => c.description)).toEqual(['Resynced', 'Service status']);
        expect(state.expandKey.value).toBeNull();
    });

    it('follows a command whose visibility moved it to another target, and opens it', async () => {
        listMock.mockResolvedValue(list([], { commands: [savedCommand()] }));
        const state = useBehaviorList();
        await state.load();
        state.selected.value = 'bot_dm';
        await state.applyCommand(
            savedCommand({ integrationTypes: ['guild_install', 'user_install'], target: 'app', section: 'app' })
        );
        expect(state.selected.value).toBe('app');
        expect(state.expandKey.value).toBe('command:4');
    });

    it('a created command is listed and opened where it lives', async () => {
        const created = savedCommand({ id: 9, target: 'app', section: 'app' });
        listMock.mockResolvedValue(list([], { commands: [created] }));
        const state = useBehaviorList();
        state.selected.value = 'bot_dm';
        await state.showCreated(created);
        expect(state.selected.value).toBe('app');
        expect(state.expandKey.value).toBe('command:9');
    });
});

describe('useBehaviorList — the system login (#139)', () => {
    it('follows the login to the target its new trigger lives in, and opens it', async () => {
        listMock.mockResolvedValue(list([], { system: systemLoginMessage() }));
        const state = useBehaviorList();
        await state.load();
        expect(state.selected.value).toBe('bot_dm');
        const moved = systemLoginCommand({
            integrationTypes: ['guild_install', 'user_install'],
            target: 'app',
            section: 'app',
        });
        await state.applySystem(moved);
        expect(state.view.value?.system).toEqual(moved);
        expect(state.selected.value).toBe('app');
        expect(state.expandKey.value).toBe('command:9');
    });

    it('stays in the target when the login stays there', async () => {
        listMock.mockResolvedValue(list([], { system: systemLoginMessage() }));
        const state = useBehaviorList();
        await state.load();
        await state.applySystem(systemLoginCommand());
        expect(state.selected.value).toBe('bot_dm');
        expect(state.expandKey.value).toBeNull();
    });
});

describe('useBehaviorList', () => {
    it('takes a saved trigger in place, staying in the target', async () => {
        listMock.mockResolvedValue(list([trigger(1), trigger(2)]));
        const state = useBehaviorList();
        await state.load();
        state.selected.value = 'bot_dm';

        await state.applyTrigger(trigger(2, { title: 'renamed' }));
        expect(state.view.value?.messageTriggers.map((m) => m.title)).toEqual(['t1', 'renamed']);
        expect(state.selected.value).toBe('bot_dm');
        expect(state.expandKey.value).toBeNull();
    });

    it('follows a trigger that moved to another target and opens it', async () => {
        listMock.mockResolvedValue(list([trigger(1)]));
        const state = useBehaviorList();
        await state.load();

        state.selected.value = 'bot_dm';
        await state.applyTrigger(inGuild(1));
        expect(state.selected.value).toBe(`guild:${GUILD}`);
        expect(state.expandKey.value).toBe('message:1');
        // the target is one the list already has: no reload
        expect(listMock).toHaveBeenCalledTimes(1);
    });

    it('a trigger whose audience changed moves to that user, though it stays in bot DMs', async () => {
        listMock.mockResolvedValue(list([trigger(1)]));
        const state = useBehaviorList();
        await state.load();
        state.selected.value = 'bot_dm';

        await state.applyTrigger(forUser(1));
        expect(state.selected.value).toBe(`user:${USER}`);
        expect(state.expandKey.value).toBe('message:1');
    });

    it('reloads to list a target the save just registered, then follows the trigger there', async () => {
        listMock.mockResolvedValueOnce({ ...list([trigger(1)]), targets: BUILTIN_TARGETS });
        const state = useBehaviorList();
        await state.load();
        state.selected.value = 'bot_dm';

        listMock.mockResolvedValueOnce(list([forUser(1)]));
        await state.applyTrigger(forUser(1));
        expect(listMock).toHaveBeenCalledTimes(2);
        expect(state.selectedTarget.value?.key).toBe(`user:${USER}`);
    });

    it('stays put when leaving would drop drafts and the admin says no', async () => {
        listMock.mockResolvedValue(list([trigger(1)]));
        const state = useBehaviorList();
        await state.load();
        state.selected.value = 'bot_dm';
        const mayLeave = vi.fn(async () => false);

        await state.applyTrigger(inAllGuilds(1), mayLeave);
        expect(mayLeave).toHaveBeenCalledTimes(1);
        expect(state.selected.value).toBe('bot_dm');
        expect(state.view.value?.messageTriggers[0].target).toBe('guild:all');
    });

    it('after a create, reloads the list and opens the new card where it lives (#104)', async () => {
        listMock.mockResolvedValueOnce(list([trigger(1)]));
        const state = useBehaviorList();
        await state.load();
        state.selected.value = 'guild:all';

        const created = inGuild(2);
        listMock.mockResolvedValueOnce(list([trigger(1), created]));
        await state.showCreated(created);

        expect(listMock).toHaveBeenCalledTimes(2);
        expect(state.view.value?.messageTriggers.map((m) => m.id)).toEqual([1, 2]);
        expect(state.selected.value).toBe(`guild:${GUILD}`);
        expect(state.expandKey.value).toBe('message:2');
    });

    it('after a create elsewhere, asks before leaving a target with drafts', async () => {
        listMock.mockResolvedValue(list([trigger(1)]));
        const state = useBehaviorList();
        await state.load();
        state.selected.value = 'bot_dm';
        const mayLeave = vi.fn(async () => false);

        await state.showCreated(inAllGuilds(2), mayLeave);
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

describe('useBehaviorList — targets', () => {
    it('a created target is listed and selected', async () => {
        listMock.mockResolvedValueOnce({ ...list([]), targets: BUILTIN_TARGETS });
        const state = useBehaviorList();
        await state.load();
        expect(state.selected.value).toBe('app');

        const vip = createdTarget('group:vip');
        listMock.mockResolvedValueOnce({ ...list([]), targets: [...BUILTIN_TARGETS, vip] });
        await state.showTarget(vip);
        expect(state.selectedTarget.value).toEqual(vip);
    });

    it('a created target is listed but not selected when leaving would drop drafts', async () => {
        listMock.mockResolvedValue(list([]));
        const state = useBehaviorList();
        await state.load();
        state.selected.value = 'bot_dm';
        await state.showTarget(user, async () => false);
        expect(state.selected.value).toBe('bot_dm');
        expect(state.targets.value).toContainEqual(user);
    });

    it('a group’s new member count shows on its target', async () => {
        const vip = createdTarget('group:vip');
        listMock.mockResolvedValue({ ...list([]), targets: [...BUILTIN_TARGETS, vip] });
        const state = useBehaviorList();
        await state.load();
        state.applyMemberCount('group:vip', 3);
        expect(state.targets.value.find((t) => t.key === 'group:vip')?.memberCount).toBe(3);
    });
});

describe('useBehaviorList — reordering a target', () => {
    it('shows the new order at once and sends the whole order of the target’s location', async () => {
        listMock.mockResolvedValue(list([trigger(1), inAllGuilds(2), trigger(3), trigger(4)]));
        reorderMock.mockResolvedValue({ location: 'bot_dm', ids: [4, 1, 3] });
        const state = useBehaviorList();
        await state.load();

        await state.reorder(builtinTarget('bot_dm'), [4, 1, 3]);
        expect(reorderMock).toHaveBeenCalledWith('bot_dm', [4, 1, 3]);
        // the other location's trigger keeps its place in the list
        expect(state.view.value?.messageTriggers.map((m) => m.id)).toEqual([4, 2, 1, 3]);
        expect(listMock).toHaveBeenCalledTimes(1);
    });

    it('a user’s triggers move within the slots they hold in bot DMs; everyone’s stay put', async () => {
        listMock.mockResolvedValue(list([trigger(1), forUser(2), trigger(3), forUser(4)]));
        reorderMock.mockResolvedValue({});
        const state = useBehaviorList();
        await state.load();

        await state.reorder(user, [4, 2]);
        expect(reorderMock).toHaveBeenCalledWith('bot_dm', [1, 4, 3, 2]);
        expect(state.view.value?.messageTriggers.map((m) => m.id)).toEqual([1, 4, 3, 2]);
    });

    it('a stale order reloads the list and reports the refusal', async () => {
        listMock.mockResolvedValue(list([trigger(1), trigger(3)]));
        const stale = new ApiError(409, 'the triggers at bot_dm changed', 'validation_failed', 'ids');
        reorderMock.mockRejectedValue(stale);
        const state = useBehaviorList();
        await state.load();

        await expect(state.reorder(builtinTarget('bot_dm'), [3, 1])).rejects.toBe(stale);
        expect(listMock).toHaveBeenCalledTimes(2);
        expect(state.view.value?.messageTriggers.map((m) => m.id)).toEqual([1, 3]);
    });
});

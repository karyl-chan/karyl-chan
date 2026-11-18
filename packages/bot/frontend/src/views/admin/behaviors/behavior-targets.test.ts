import { describe, expect, it } from 'vitest';
import type { BehaviorListView } from '../../../api/behavior';
import {
    countInTarget,
    itemsInTarget,
    locationOfTarget,
    locationOrderAfter,
    sectionOfTarget,
} from './behavior-targets';
import {
    BUILTIN_TARGETS,
    builtinTarget,
    createdTarget,
    savedCommand,
    savedLeaf,
    savedTrigger,
    systemLoginMessage,
} from './behavior-test-support';

const USER = '323456789012345678';
const user = createdTarget(`user:${USER}`);
const group = createdTarget('group:vip');
const guild = createdTarget('guild:G1');
const channel = createdTarget('channel:G1:C1');

const nas = {
    ...savedTrigger({ id: 200, actionSource: 'service', audienceKind: 'group', audienceGroupName: 'vip', target: 'group:vip' }),
    service: { id: 1, name: 'NAS', audience: 'nas', redirectUrl: 'https://nas.example/cb' },
};

const view: BehaviorListView = {
    targets: [...BUILTIN_TARGETS, guild, channel, group, user],
    system: systemLoginMessage(),
    services: [nas],
    commands: [
        savedCommand({ id: 1, target: 'app', section: 'app' }),
        savedCommand({ id: 2, target: 'guild:G1', section: 'guild:G1', leaves: [savedLeaf({ id: 21 }), savedLeaf({ id: 22 })] }),
    ],
    messageTriggers: [
        savedTrigger({ id: 10 }),
        savedTrigger({ id: 11, audienceKind: 'user', audienceUserId: USER, target: `user:${USER}` }),
        savedTrigger({ id: 12 }),
        savedTrigger({ id: 13, audienceKind: 'group', audienceGroupName: 'vip', target: 'group:vip' }),
        savedTrigger({ id: 14, audienceKind: 'user', audienceUserId: USER, target: `user:${USER}` }),
        savedTrigger({ id: 15, surface: 'guild', guildId: 'G1', channelId: 'C1', target: 'channel:G1:C1', section: 'channel:G1:C1' }),
    ],
};

describe('itemsInTarget', () => {
    it('everyone’s DMs hold only what is for everyone; a user and a group hold their own', () => {
        const dm = itemsInTarget(view, 'bot_dm');
        expect(dm.system?.id).toBe(1);
        expect(dm.messageTriggers.map((m) => m.id)).toEqual([10, 12]);
        expect(itemsInTarget(view, `user:${USER}`).messageTriggers.map((m) => m.id)).toEqual([11, 14]);
        expect(itemsInTarget(view, 'group:vip').messageTriggers.map((m) => m.id)).toEqual([13]);
    });

    it('a Service Behavior is listed with the target its audience puts it in', () => {
        expect(itemsInTarget(view, 'group:vip').services.map((s) => s.service.id)).toEqual([1]);
        expect(itemsInTarget(view, 'bot_dm').services).toEqual([]);
    });

    it('a command is in the target its section is', () => {
        expect(itemsInTarget(view, 'app').commands.map((c) => c.id)).toEqual([1]);
        expect(itemsInTarget(view, 'guild:G1').commands.map((c) => c.id)).toEqual([2]);
        expect(itemsInTarget(view, 'channel:G1:C1').messageTriggers.map((m) => m.id)).toEqual([15]);
    });

    it('counts behaviors: a command counts by its leaves', () => {
        expect(countInTarget(view, 'bot_dm')).toBe(3);
        expect(countInTarget(view, 'guild:G1')).toBe(2);
        expect(countInTarget(view, 'group:vip')).toBe(2);
        expect(countInTarget(view, 'guild:all')).toBe(0);
    });
});

describe('where a target’s triggers are', () => {
    it('a user’s and a group’s are in bot DMs; App 指令 holds none', () => {
        expect(locationOfTarget(builtinTarget('app'))).toBeNull();
        expect(locationOfTarget(builtinTarget('bot_dm'))).toBe('bot_dm');
        expect(locationOfTarget(user)).toBe('bot_dm');
        expect(locationOfTarget(group)).toBe('bot_dm');
        expect(locationOfTarget(builtinTarget('guild:all'))).toBe('guild:all');
        expect(locationOfTarget(guild)).toBe('guild:G1');
        expect(locationOfTarget(channel)).toBe('channel:G1:C1');
    });

    it('only a location-only target is a section a command can be preset for', () => {
        expect(sectionOfTarget(builtinTarget('bot_dm'))).toBe('bot_dm');
        expect(sectionOfTarget(guild)).toBe('guild:G1');
        expect(sectionOfTarget(user)).toBeNull();
        expect(sectionOfTarget(group)).toBeNull();
    });
});

describe('locationOrderAfter', () => {
    it('puts a target’s new order in the slots it holds in its location; the other targets keep theirs', () => {
        // bot DMs hold 10, 11, 12, 13, 14 (the login is pinned, not among them)
        expect(locationOrderAfter(view, user, [14, 11])).toEqual({ location: 'bot_dm', ids: [10, 14, 12, 13, 11] });
        expect(locationOrderAfter(view, builtinTarget('bot_dm'), [12, 10])).toEqual({
            location: 'bot_dm',
            ids: [12, 11, 10, 13, 14],
        });
    });

    it('a location-only target elsewhere is its whole location', () => {
        expect(locationOrderAfter(view, channel, [15])).toEqual({ location: 'channel:G1:C1', ids: [15] });
    });

    it('App 指令 has nothing to order', () => {
        expect(locationOrderAfter(view, builtinTarget('app'), [])).toBeNull();
    });
});

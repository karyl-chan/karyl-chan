import { describe, expect, it } from 'vitest';
import { builtinTarget, createdTarget } from './behavior-test-support';
import { newBehaviorOptions } from './new-behavior-options';

const GUILD = '123456789012345678';
const CHANNEL = '223456789012345678';
const USER = '323456789012345678';

const EVERYONE = { kind: 'all', userId: '', groupName: '' };

describe('newBehaviorOptions — what a target lets you add (ADR 0003, ADR 0004)', () => {
    it('App 指令 holds commands only: the bot cannot read messages there', () => {
        const o = newBehaviorOptions(builtinTarget('app'));
        expect(o.command).toEqual({ possible: true, reason: null });
        expect(o.message.possible).toBe(false);
        expect(o.message.reason).toBe('behaviors.add.reason.messageInApp');
    });

    it('everyone’s DMs take both, a message trigger fixed to bot DMs for everyone', () => {
        const o = newBehaviorOptions(builtinTarget('bot_dm'));
        expect(o.command.possible).toBe(true);
        expect(o.message).toMatchObject({ possible: true, locations: ['bot_dm'], lockGuild: false, audience: EVERYONE });
    });

    it('all servers may still narrow a message trigger to one server or channel', () => {
        expect(newBehaviorOptions(builtinTarget('guild:all')).message).toMatchObject({
            possible: true,
            locations: ['guild_all', 'guild', 'channel'],
            lockGuild: false,
            guildId: '',
        });
    });

    it('a server fixes the server: the whole server or one of its channels', () => {
        expect(newBehaviorOptions(createdTarget(`guild:${GUILD}`)).message).toMatchObject({
            locations: ['guild', 'channel'],
            lockGuild: true,
            lockChannel: false,
            guildId: GUILD,
        });
    });

    it('a channel takes message triggers only: Discord cannot limit a command to a channel', () => {
        const o = newBehaviorOptions(createdTarget(`channel:${GUILD}:${CHANNEL}`));
        expect(o.command).toEqual({ possible: false, reason: 'behaviors.add.reason.commandInChannel' });
        expect(o.message).toMatchObject({
            possible: true,
            locations: ['channel'],
            lockGuild: true,
            lockChannel: true,
            guildId: GUILD,
            channelId: CHANNEL,
        });
    });

    it('a user takes bot DM triggers for that user only: a command has no audience', () => {
        const o = newBehaviorOptions(createdTarget(`user:${USER}`));
        expect(o.command).toEqual({ possible: false, reason: 'behaviors.add.reason.commandNeedsEveryone' });
        expect(o.message).toMatchObject({
            possible: true,
            locations: ['bot_dm'],
            audience: { kind: 'user', userId: USER, groupName: '' },
        });
    });

    it('a group takes bot DM triggers for that group only', () => {
        const o = newBehaviorOptions(createdTarget('group:vip'));
        expect(o.command.possible).toBe(false);
        expect(o.message).toMatchObject({
            locations: ['bot_dm'],
            audience: { kind: 'group', userId: '', groupName: 'vip' },
        });
    });
});

import { describe, expect, it } from 'vitest';
import { builtinTarget, createdTarget } from './behavior-test-support';
import { newBehaviorOptions } from './new-behavior-options';

const GUILD = '123456789012345678';
const CHANNEL = '223456789012345678';
const USER = '323456789012345678';

const yes = { possible: true, reason: null };

describe('newBehaviorOptions — what a target lets you add (ADR 0003, ADR 0004)', () => {
    it('App 指令 holds commands only: the bot cannot read messages there', () => {
        const o = newBehaviorOptions(builtinTarget('app'));
        expect(o.command).toEqual(yes);
        expect(o.message).toEqual({ possible: false, reason: 'behaviors.add.reason.messageInApp' });
    });

    it('everyone’s DMs, all servers and a server take both', () => {
        for (const target of [builtinTarget('bot_dm'), builtinTarget('guild:all'), createdTarget(`guild:${GUILD}`)]) {
            expect(newBehaviorOptions(target)).toEqual({ command: yes, message: yes });
        }
    });

    it('a channel takes message triggers only: Discord cannot limit a command to a channel', () => {
        const o = newBehaviorOptions(createdTarget(`channel:${GUILD}:${CHANNEL}`));
        expect(o.command).toEqual({ possible: false, reason: 'behaviors.add.reason.commandInChannel' });
        expect(o.message).toEqual(yes);
    });

    it('a user and a group take message triggers only: a command has no audience', () => {
        for (const target of [createdTarget(`user:${USER}`), createdTarget('group:vip')]) {
            const o = newBehaviorOptions(target);
            expect(o.command).toEqual({ possible: false, reason: 'behaviors.add.reason.commandNeedsEveryone' });
            expect(o.message).toEqual(yes);
        }
    });
});

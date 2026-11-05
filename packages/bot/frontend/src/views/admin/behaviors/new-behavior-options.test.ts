import { describe, expect, it } from 'vitest';
import { newBehaviorOptions } from './new-behavior-options';

const GUILD = '123456789012345678';
const CHANNEL = '223456789012345678';

describe('newBehaviorOptions — what a section lets you add (ADR 0003)', () => {
    it('App 指令 holds commands only: the bot cannot read messages there', () => {
        const o = newBehaviorOptions('app');
        expect(o.command).toEqual({ possible: true, reason: null });
        expect(o.message.possible).toBe(false);
        expect(o.message.reason).toBe('behaviors.add.reason.messageInApp');
    });

    it('bot DMs take both, a message trigger fixed to bot DMs', () => {
        const o = newBehaviorOptions('bot_dm');
        expect(o.command.possible).toBe(true);
        expect(o.message).toMatchObject({ possible: true, locations: ['bot_dm'], lockGuild: false });
    });

    it('all servers may still narrow a message trigger to one server or channel', () => {
        expect(newBehaviorOptions('guild:all').message).toMatchObject({
            possible: true,
            locations: ['guild_all', 'guild', 'channel'],
            lockGuild: false,
            guildId: '',
        });
    });

    it('a server fixes the server: the whole server or one of its channels', () => {
        expect(newBehaviorOptions(`guild:${GUILD}`).message).toMatchObject({
            locations: ['guild', 'channel'],
            lockGuild: true,
            lockChannel: false,
            guildId: GUILD,
        });
    });

    it('a channel takes message triggers only: Discord cannot limit a command to a channel', () => {
        const o = newBehaviorOptions(`channel:${GUILD}:${CHANNEL}`);
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
});

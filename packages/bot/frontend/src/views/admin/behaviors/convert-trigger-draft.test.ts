import { describe, expect, it } from 'vitest';
import {
    commandNameOf,
    commandsWithSubcommands,
    convertedCommandDraft,
    convertedMessageDraft,
    singleCommands,
    toMessageBody,
} from './convert-trigger-draft';
import { savedCommand, savedLeaf, savedTrigger, systemLoginCommand } from './behavior-test-support';

const GUILD = '123456789012345678';
const CHANNEL = '223456789012345678';

describe('message → command: where it starts', () => {
    it('makes a command name of the title, or leaves it empty', () => {
        expect(commandNameOf('Weather Today!')).toBe('weather-today');
        expect(commandNameOf('  nas_wake  ')).toBe('nas_wake');
        expect(commandNameOf('天氣')).toBe('');
        expect(commandNameOf('x'.repeat(40))).toHaveLength(32);
    });

    it("takes the visibility a new command gets in the trigger's section", () => {
        expect(convertedCommandDraft(savedTrigger())).toMatchObject({ registration: 'global', contexts: ['BotDM'] });
        expect(
            convertedCommandDraft(savedTrigger({ surface: 'guild', section: 'guild:all' }))
        ).toMatchObject({ registration: 'global', contexts: ['Guild'] });
        // Discord cannot limit a command to a channel: the channel's server
        expect(
            convertedCommandDraft(
                savedTrigger({ surface: 'guild', guildId: GUILD, channelId: CHANNEL, section: `channel:${GUILD}:${CHANNEL}` })
            )
        ).toMatchObject({ registration: 'guild', guildId: GUILD, contexts: ['Guild'] });
    });

    it('offers only commands with subcommands, never the login', () => {
        const tree = savedCommand({ id: 5, leaves: [savedLeaf({ subcommand: 'a' }), savedLeaf({ id: 22, subcommand: 'b' })] });
        const single = savedCommand({ id: 6 });
        const commands = [tree, single, systemLoginCommand()];
        expect(commandsWithSubcommands(commands).map((c) => c.id)).toEqual([5]);
        expect(singleCommands(commands).map((c) => c.id)).toEqual([6]);
    });
});

describe('command → message: the request', () => {
    it("starts in the command's own section", () => {
        const command = savedCommand({ section: `guild:${GUILD}`, registration: 'guild', guildId: GUILD });
        expect(convertedMessageDraft(command)).toMatchObject({ locationKind: 'guild', guildId: GUILD });
        expect(convertedMessageDraft(savedCommand({ section: 'app' })).locationKind).toBe('bot_dm');
    });

    it('sends the location key and only the fields that apply there', () => {
        const draft = { ...convertedMessageDraft(savedCommand()), patternValue: '!s' };
        expect(toMessageBody(draft)).toEqual({
            location: 'bot_dm',
            patternKind: 'startswith',
            patternValue: '!s',
            stopOnMatch: false,
            audienceKind: 'all',
            audienceUserId: null,
            audienceGroupName: null,
        });
        expect(
            toMessageBody({ ...draft, locationKind: 'channel', guildId: GUILD, channelId: CHANNEL, ignoreBots: false })
        ).toEqual({
            location: `channel:${GUILD}:${CHANNEL}`,
            patternKind: 'startswith',
            patternValue: '!s',
            stopOnMatch: false,
            ignoreBots: false,
        });
        expect(toMessageBody({ ...draft, locationKind: 'guild', guildId: '' })).toBeNull();
    });
});

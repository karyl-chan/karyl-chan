import { describe, expect, it } from 'vitest';
import {
    commandPatch,
    draftFromCommand,
    draftSection,
    newCommandVisibility,
    withRegistration,
} from './command-draft';
import { savedCommand } from './behavior-test-support';

const GUILD = '123456789012345678';

describe('command draft', () => {
    it('an untouched draft changes nothing', () => {
        expect(commandPatch(savedCommand(), draftFromCommand(savedCommand()))).toBeNull();
    });

    it('a PATCH carries only the changed fields and the version it is based on', () => {
        const draft = { ...draftFromCommand(savedCommand()), description: '  Uptime  ' };
        expect(commandPatch(savedCommand(), draft)).toEqual({
            description: 'Uptime',
            ifUpdatedAt: '2026-10-27T00:00:00.000Z',
        });
    });

    it('the order contexts were ticked in is not a change', () => {
        const saved = savedCommand({ contexts: ['BotDM', 'Guild'] });
        const draft = { ...draftFromCommand(saved), contexts: ['Guild' as const, 'BotDM' as const] };
        expect(commandPatch(saved, draft)).toBeNull();
    });

    it('moving to one server fixes what Discord fixes for a server command', () => {
        const draft = withRegistration(
            { ...draftFromCommand(savedCommand()), integrationTypes: ['guild_install', 'user_install'], contexts: ['BotDM'] },
            'guild',
        );
        expect(draft).toMatchObject({ registration: 'guild', contexts: ['Guild'], integrationTypes: ['guild_install'] });
        expect(commandPatch(savedCommand(), { ...draft, guildId: GUILD })).toEqual({
            registration: 'guild',
            guildId: GUILD,
            contexts: ['Guild'],
            ifUpdatedAt: '2026-10-27T00:00:00.000Z',
        });
    });

    it('moving back to global drops the server', () => {
        const saved = savedCommand({ registration: 'guild', guildId: GUILD, contexts: ['Guild'], section: `guild:${GUILD}` });
        const draft = withRegistration(draftFromCommand(saved), 'global');
        expect(draft.guildId).toBe('');
        expect(commandPatch(saved, draft)).toMatchObject({ registration: 'global', guildId: null });
    });

    it('default member permissions: empty means everyone (null)', () => {
        const saved = savedCommand({ defaultMemberPermissions: '32' });
        const draft = { ...draftFromCommand(saved), defaultMemberPermissions: '' };
        expect(commandPatch(saved, draft)).toMatchObject({ defaultMemberPermissions: null });
    });

    it('the section a draft would land in', () => {
        const draft = draftFromCommand(savedCommand());
        expect(draftSection(draft)).toBe('bot_dm');
        expect(draftSection({ ...draft, integrationTypes: ['guild_install', 'user_install'] })).toBe('app');
        expect(draftSection(withRegistration(draft, 'guild'))).toBeNull(); // no server picked yet
        expect(draftSection({ ...withRegistration(draft, 'guild'), guildId: GUILD })).toBe(`guild:${GUILD}`);
    });
});

describe('newCommandVisibility — a new command starts where it is created (board 2)', () => {
    it.each([
        ['app', { registration: 'global', integrationTypes: ['guild_install', 'user_install'], contexts: ['Guild', 'BotDM', 'PrivateChannel'] }],
        ['bot_dm', { registration: 'global', integrationTypes: ['guild_install'], contexts: ['BotDM'] }],
        ['guild:all', { registration: 'global', integrationTypes: ['guild_install'], contexts: ['Guild'] }],
        [`guild:${GUILD}`, { registration: 'guild', guildId: GUILD, integrationTypes: ['guild_install'], contexts: ['Guild'] }],
    ] as const)('in %s', (section, expected) => {
        const preset = newCommandVisibility(section);
        expect(preset).toMatchObject(expected);
        expect(draftSection({ ...draftFromCommand(savedCommand()), ...preset })).toBe(section);
    });

    it('a channel cannot hold a command', () => {
        expect(newCommandVisibility(`channel:${GUILD}:223456789012345678`)).toBeNull();
    });
});

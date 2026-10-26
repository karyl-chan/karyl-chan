import { describe, expect, it } from 'vitest';
import {
    DEFAULT_LOGIN_COMMAND,
    globalVisibilityOf,
    loginDraftSection,
    loginTriggerDraftErrors,
    loginTriggerDraftOf,
    loginTriggerPatch,
    loginTriggerText,
    switchesKind,
} from './login-trigger-draft';
import { systemLoginCommand, systemLoginMessage } from './behavior-test-support';

describe('login trigger draft', () => {
    it('an untouched draft changes nothing, on either kind', () => {
        for (const saved of [systemLoginMessage(), systemLoginCommand()]) {
            expect(loginTriggerPatch(saved, loginTriggerDraftOf(saved))).toBeNull();
        }
    });

    it('a message login starts its command half from the defaults', () => {
        expect(loginTriggerDraftOf(systemLoginMessage())).toMatchObject({
            kind: 'message',
            patternKind: 'startswith',
            patternValue: '!login',
            sample: '',
            name: 'login',
            description: DEFAULT_LOGIN_COMMAND.description,
            integrationTypes: ['guild_install'],
            contexts: ['BotDM'],
        });
    });

    it("offers the login command's own description", () => {
        expect(DEFAULT_LOGIN_COMMAND.description).toBe('取得 admin 後台一次性登入連結(僅授權使用者)');
    });

    it('a command login keeps `!login` ready for switching back', () => {
        expect(loginTriggerDraftOf(systemLoginCommand())).toMatchObject({
            kind: 'command',
            name: 'login',
            patternKind: 'startswith',
            patternValue: '!login',
        });
    });

    it('a stored regex comes back as a kind the login may use', () => {
        const draft = loginTriggerDraftOf(systemLoginMessage({ patternKind: 'regex', patternValue: '^!login$' }));
        expect(draft.patternKind).toBe('startswith');
    });

    it('switching to a command sends the whole command and the version it is based on', () => {
        const saved = systemLoginMessage();
        const draft = { ...loginTriggerDraftOf(saved), kind: 'command' as const, description: '  Sign in  ' };
        expect(loginTriggerPatch(saved, draft)).toEqual({
            kind: 'command',
            name: 'login',
            description: 'Sign in',
            integrationTypes: ['guild_install'],
            contexts: ['BotDM'],
            ifUpdatedAt: saved.updatedAt,
        });
        expect(switchesKind(saved, draft)).toBe(true);
    });

    it('a new pattern is a change of the same kind, sent with its sample', () => {
        const saved = systemLoginMessage();
        const draft = { ...loginTriggerDraftOf(saved), patternValue: '!admin', sample: '!admin' };
        expect(loginTriggerPatch(saved, draft)).toEqual({
            kind: 'message',
            patternKind: 'startswith',
            patternValue: '!admin',
            sample: '!admin',
            ifUpdatedAt: saved.updatedAt,
        });
        expect(switchesKind(saved, draft)).toBe(false);
    });

    it('a sample alone is not a change', () => {
        const saved = systemLoginMessage();
        expect(loginTriggerPatch(saved, { ...loginTriggerDraftOf(saved), sample: '!login' })).toBeNull();
    });

    it('edits to the half that is not chosen are not a change', () => {
        const saved = systemLoginMessage();
        expect(loginTriggerPatch(saved, { ...loginTriggerDraftOf(saved), name: 'other' })).toBeNull();
    });

    it('the order contexts were ticked in is not a change', () => {
        const saved = systemLoginCommand({ contexts: ['BotDM', 'Guild'], section: 'app' });
        const draft = { ...loginTriggerDraftOf(saved), contexts: ['Guild' as const, 'BotDM' as const] };
        expect(loginTriggerPatch(saved, draft)).toBeNull();
    });

    it('says the trigger the way a user sends it', () => {
        expect(loginTriggerText(loginTriggerDraftOf(systemLoginMessage()))).toBe('!login');
        expect(loginTriggerText(loginTriggerDraftOf(systemLoginCommand({ name: 'signin' })))).toBe('/signin');
    });

    it('lands a message login in bot DMs, a command where its visibility puts it', () => {
        const draft = loginTriggerDraftOf(systemLoginMessage());
        expect(loginDraftSection(draft)).toBe('bot_dm');
        expect(loginDraftSection({ ...draft, kind: 'command' })).toBe('bot_dm');
        expect(loginDraftSection({ ...draft, kind: 'command', integrationTypes: ['guild_install', 'user_install'] })).toBe('app');
        expect(loginDraftSection({ ...draft, kind: 'command', contexts: ['BotDM', 'Guild'] })).toBe('app');
    });

    it('the login command is always global', () => {
        expect(globalVisibilityOf({ integrationTypes: ['guild_install'], contexts: ['BotDM'] })).toEqual({
            registration: 'global',
            guildId: null,
            integrationTypes: ['guild_install'],
            contexts: ['BotDM'],
        });
    });
});

describe('login trigger draft errors', () => {
    const t = (key: string) => key;
    const SCHEMA = {
        type: 'object',
        properties: {
            kind: { enum: ['message', 'command'] },
            patternValue: { type: 'string', minLength: 1, maxLength: 500 },
            sample: { type: 'string', minLength: 1, maxLength: 2000 },
            name: { type: 'string', pattern: '^[a-z0-9_-]{1,32}$' },
            description: { type: 'string', minLength: 1, maxLength: 100, pattern: '\\S' },
            contexts: { type: 'array', minItems: 1 },
            integrationTypes: { type: 'array', minItems: 1 },
        },
        required: ['kind'],
    };
    const message = () => ({ ...loginTriggerDraftOf(systemLoginMessage()), sample: '!login' });

    it('checks only the chosen half', () => {
        const draft = { ...message(), name: 'Not A Name' };
        expect(loginTriggerDraftErrors(t, draft, SCHEMA).fields).toEqual({});
        expect(loginTriggerDraftErrors(t, { ...draft, kind: 'command' }, SCHEMA).fields).toHaveProperty('name');
    });

    it('a message needs a sample DM the pattern matches, as Discord delivers it', () => {
        expect(loginTriggerDraftErrors(t, { ...message(), sample: '  ' }, null).fields).toEqual({
            sample: 'behaviors.system.sampleRequired',
        });
        expect(loginTriggerDraftErrors(t, { ...message(), sample: '!Login' }, null).fields).toEqual({
            sample: 'behaviors.system.sampleNoMatch',
        });
        expect(loginTriggerDraftErrors(t, { ...message(), sample: '  !login please ' }, null).fields).toEqual({});
    });

    it("applies Discord's visibility rules to a command", () => {
        const draft = {
            ...loginTriggerDraftOf(systemLoginCommand()),
            contexts: ['BotDM' as const, 'PrivateChannel' as const],
        };
        expect(loginTriggerDraftErrors(t, draft, null).fields).toEqual({
            contexts: 'behaviors.command.rule.privateChannelNeedsUserInstall',
        });
    });

    it('the login command keeps guild install and bot DMs', () => {
        const command = loginTriggerDraftOf(systemLoginCommand());
        expect(loginTriggerDraftErrors(t, { ...command, integrationTypes: ['user_install'] }, null).fields).toEqual({
            integrationTypes: 'behaviors.system.rule.needsGuildInstall',
        });
        expect(loginTriggerDraftErrors(t, { ...command, contexts: ['Guild'] }, null).fields).toEqual({
            contexts: 'behaviors.system.rule.needsBotDm',
        });
    });

    it('lets the system login take /login', () => {
        expect(loginTriggerDraftErrors(t, loginTriggerDraftOf(systemLoginCommand()), SCHEMA).fields).toEqual({});
    });
});

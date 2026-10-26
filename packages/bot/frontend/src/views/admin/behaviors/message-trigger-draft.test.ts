import { describe, expect, it } from 'vitest';
import type { MessageTriggerView } from '../../../api/behavior';
import {
    draftFromTrigger,
    draftLocation,
    emptyDraft,
    previewMatch,
    toCreateBody,
    toPatchBody,
    withLocationKind,
} from './message-trigger-draft';

const GUILD = '123456789012345678';
const CHANNEL = '223456789012345678';
const USER = '323456789012345678';

function trigger(overrides: Partial<MessageTriggerView> = {}): MessageTriggerView {
    return {
        kind: 'message',
        id: 7,
        title: 'weather',
        description: '',
        enabled: true,
        sortOrder: 0,
        systemKey: null,
        actionSource: 'webhook',
        webhook: { url: 'https://hook.example/w', authMode: null, secretSet: false, previousSecretExpiresAt: null },
        stats: null,
        updatedAt: '2026-10-27T00:00:00.000Z',
        surface: 'bot_dm',
        guildId: null,
        channelId: null,
        patternKind: 'startswith',
        patternValue: '!w',
        stopOnMatch: false,
        ignoreBots: true,
        audienceKind: 'user',
        audienceUserId: USER,
        audienceGroupName: null,
        section: 'bot_dm',
        ...overrides,
    };
}

describe('draft ↔ request body', () => {
    it('a saved trigger reads back as the body that would create it', () => {
        expect(toCreateBody(draftFromTrigger(trigger()))).toEqual({
            title: 'weather',
            description: '',
            surface: 'bot_dm',
            guildId: null,
            channelId: null,
            patternKind: 'startswith',
            patternValue: '!w',
            stopOnMatch: false,
            ignoreBots: true,
            audienceKind: 'user',
            audienceUserId: USER,
            audienceGroupName: null,
            webhook: { url: 'https://hook.example/w', authMode: null },
        });
    });

    it('a new trigger in a channel starts there, for everyone, ignoring bots', () => {
        const body = toCreateBody({
            ...emptyDraft({ kind: 'channel', guildId: GUILD, channelId: CHANNEL }),
            title: 'q',
            patternValue: '?',
            webhookUrl: 'https://hook.example/q',
            authMode: 'hmac',
        });
        expect(body).toMatchObject({
            surface: 'guild',
            guildId: GUILD,
            channelId: CHANNEL,
            audienceKind: 'all',
            ignoreBots: true,
            webhook: { url: 'https://hook.example/q', authMode: 'hmac' },
        });
    });

    it('keeps an empty id in the body so the schema can name the field', () => {
        const body = toCreateBody(emptyDraft({ kind: 'guild' }));
        expect(body.guildId).toBe('');
    });
});

describe('toPatchBody', () => {
    it('is null while nothing differs from the saved trigger', () => {
        expect(toPatchBody(trigger(), draftFromTrigger(trigger()))).toBeNull();
    });

    it('sends only what changed, with the version it was based on', () => {
        const draft = { ...draftFromTrigger(trigger()), title: 'forecast' };
        expect(toPatchBody(trigger(), draft)).toEqual({
            title: 'forecast',
            ifUpdatedAt: '2026-10-27T00:00:00.000Z',
        });
    });

    it('moving a user-audience DM trigger to a guild drops the audience with it', () => {
        const draft = { ...withLocationKind(draftFromTrigger(trigger()), 'guild'), guildId: GUILD };
        expect(toPatchBody(trigger(), draft)).toEqual({
            surface: 'guild',
            guildId: GUILD,
            audienceKind: 'all',
            audienceUserId: null,
            ifUpdatedAt: '2026-10-27T00:00:00.000Z',
        });
    });

    it('sends the whole webhook when its URL or authentication changes', () => {
        const draft = { ...draftFromTrigger(trigger()), authMode: 'hmac' as const };
        expect(toPatchBody(trigger(), draft)).toEqual({
            webhook: { url: 'https://hook.example/w', authMode: 'hmac' },
            ifUpdatedAt: '2026-10-27T00:00:00.000Z',
        });
    });
});

describe('draftLocation', () => {
    it('is structured, and null until the ids it needs are filled in', () => {
        expect(draftLocation(emptyDraft({ kind: 'guild_all' }))).toEqual({ kind: 'guild_all' });
        expect(draftLocation(emptyDraft({ kind: 'guild' }))).toBeNull();
        expect(draftLocation(emptyDraft({ kind: 'channel', guildId: GUILD }))).toBeNull();
        expect(draftLocation(emptyDraft({ kind: 'channel', guildId: GUILD, channelId: CHANNEL }))).toEqual({
            kind: 'channel',
            guildId: GUILD,
            channelId: CHANNEL,
        });
    });
});

describe('withLocationKind', () => {
    it('a guild location has no audience; a bot DM has no guild and always ignores bots', () => {
        const dm = { ...draftFromTrigger(trigger()), audienceKind: 'group' as const, audienceGroupName: 'ops' };
        const guild = withLocationKind(dm, 'channel');
        expect(guild).toMatchObject({ audienceKind: 'all', audienceUserId: '', audienceGroupName: '' });

        const back = withLocationKind({ ...guild, guildId: GUILD, channelId: CHANNEL, ignoreBots: false }, 'bot_dm');
        expect(back).toMatchObject({ guildId: '', channelId: '', ignoreBots: true });
    });

    it('narrowing a channel to its guild keeps the guild', () => {
        const draft = { ...emptyDraft({ kind: 'channel', guildId: GUILD, channelId: CHANNEL }) };
        expect(withLocationKind(draft, 'guild')).toMatchObject({ guildId: GUILD, channelId: '' });
        expect(withLocationKind(draft, 'guild_all')).toMatchObject({ guildId: '', channelId: '' });
    });
});

describe('previewMatch — the "try it" box', () => {
    it('matches the way the bot does', () => {
        expect(previewMatch('startswith', '!w', '!w taipei')).toBe('match');
        expect(previewMatch('endswith', '?', 'why?')).toBe('match');
        expect(previewMatch('startswith', '!w', 'say !w')).toBe('no_match');
        expect(previewMatch('regex', '^天氣\\s+(.+)', '天氣 台北')).toBe('match');
        expect(previewMatch('regex', '(', 'x')).toBe('invalid');
    });
});

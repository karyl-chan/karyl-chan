import { describe, expect, it } from 'vitest';
import type { MessageTriggerView } from '../../../api/behavior';
import { builtinTarget, createdTarget } from './behavior-test-support';
import {
    draftFromTrigger,
    draftLocation,
    draftTarget,
    emptyDraft,
    previewCaptures,
    previewMatch,
    toCreateBody,
    toPatchBody,
    withTarget,
    type MessageTriggerDraft,
} from './message-trigger-draft';

/** The draft, moved to `target` — what choosing it in the form's target select does. */
const moved = (draft: MessageTriggerDraft, target: Parameters<typeof withTarget>[1]): MessageTriggerDraft => ({
    ...draft,
    ...withTarget(draft, target),
});

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
        pluginAction: null,
        stats: null,
        updatedAt: '2026-10-27T00:00:00.000Z',
        replyVisibility: null,
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
        target: 'bot_dm',
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
            replyVisibility: null,
            webhook: { url: 'https://hook.example/w', authMode: null },
        });
    });

    it('sends the reply default for a guild trigger, never for a bot DM one', () => {
        const guild = { ...emptyDraft({ kind: 'guild_all' }), replyVisibility: 'private' as const };
        expect(toCreateBody(guild).replyVisibility).toBe('private');
        expect(toCreateBody(moved(guild, builtinTarget('bot_dm'))).replyVisibility).toBeNull();
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
        const draft = moved(draftFromTrigger(trigger()), createdTarget(`guild:${GUILD}`));
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

describe('draftTarget — the target a draft’s fields add up to', () => {
    const dm = emptyDraft({ kind: 'bot_dm' });

    it('a bot DM trigger is everyone’s, one user’s or one group’s', () => {
        expect(draftTarget(dm)).toBe('bot_dm');
        expect(draftTarget({ ...dm, audienceKind: 'user', audienceUserId: USER })).toBe(`user:${USER}`);
        expect(draftTarget({ ...dm, audienceKind: 'group', audienceGroupName: ' ops ' })).toBe('group:ops');
        // an audience kind without its id or name is still everyone's
        expect(draftTarget({ ...dm, audienceKind: 'user' })).toBe('bot_dm');
    });

    it('a server trigger is at its location, and has none until its ids are filled in', () => {
        expect(draftTarget(emptyDraft({ kind: 'guild_all' }))).toBe('guild:all');
        expect(draftTarget(emptyDraft({ kind: 'guild', guildId: GUILD }))).toBe(`guild:${GUILD}`);
        expect(draftTarget(emptyDraft({ kind: 'channel', guildId: GUILD, channelId: CHANNEL }))).toBe(
            `channel:${GUILD}:${CHANNEL}`
        );
        expect(draftTarget(emptyDraft({ kind: 'guild' }))).toBeNull();
        expect(draftTarget(emptyDraft({ kind: 'channel', guildId: GUILD }))).toBeNull();
    });
});

describe('withTarget — choosing a target sets where and for whom', () => {
    const dm = { ...draftFromTrigger(trigger()), audienceKind: 'group' as const, audienceGroupName: 'ops' };

    it('a server target is for everyone; back in bot DMs there is no guild and bots are always ignored', () => {
        const channel = moved(dm, createdTarget(`channel:${GUILD}:${CHANNEL}`));
        expect(channel).toMatchObject({
            locationKind: 'channel',
            guildId: GUILD,
            channelId: CHANNEL,
            audienceKind: 'all',
            audienceUserId: '',
            audienceGroupName: '',
        });

        const back = moved({ ...channel, ignoreBots: false }, builtinTarget('bot_dm'));
        expect(back).toMatchObject({ locationKind: 'bot_dm', guildId: '', channelId: '', ignoreBots: true });
    });

    it('a user’s and a group’s targets are bot DMs for that user or group only', () => {
        expect(moved(dm, createdTarget(`user:${USER}`))).toMatchObject({
            locationKind: 'bot_dm',
            audienceKind: 'user',
            audienceUserId: USER,
            audienceGroupName: '',
        });
        const guild = emptyDraft({ kind: 'guild', guildId: GUILD });
        expect(moved(guild, createdTarget('group:vip'))).toMatchObject({
            locationKind: 'bot_dm',
            guildId: '',
            audienceKind: 'group',
            audienceUserId: '',
            audienceGroupName: 'vip',
        });
    });

    it('every target it sets is the target the draft then adds up to', () => {
        const targets = [
            builtinTarget('bot_dm'),
            builtinTarget('guild:all'),
            createdTarget(`guild:${GUILD}`),
            createdTarget(`channel:${GUILD}:${CHANNEL}`),
            createdTarget(`user:${USER}`),
            createdTarget('group:vip'),
        ];
        for (const target of targets) expect(draftTarget(moved(dm, target))).toBe(target.key);
    });

    it('App 指令 holds no message trigger: choosing it changes nothing', () => {
        expect(withTarget(dm, builtinTarget('app'))).toEqual({});
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

describe('previewCaptures — the groups the service will receive', () => {
    it('lists the groups of a regex match, group 1 first', () => {
        expect(previewCaptures('regex', '^天氣\\s+(.+)', '天氣 台北')).toEqual(['台北']);
        expect(previewCaptures('regex', '^!go( fast)?(!)?$', '!go!')).toEqual([null, '!']);
    });

    it('is empty without groups, without a match, or for a broken regex', () => {
        expect(previewCaptures('startswith', '!w', '!w x')).toEqual([]);
        expect(previewCaptures('regex', '^!w', '!w')).toEqual([]);
        expect(previewCaptures('regex', '^(x)', 'y')).toEqual([]);
        expect(previewCaptures('regex', '(', 'x')).toEqual([]);
    });
});

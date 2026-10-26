import { describe, expect, it } from 'vitest';
import type { MessageTriggerView } from '../../../api/behavior';
import { keepEditsOnWith, rebaseDraftWith } from './draft-rebase';
import { draftFromTrigger, messageTriggerDraftModel, toPatchBody } from './message-trigger-draft';

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

describe('rebaseDraftWith — saved state vs. the edit draft (#105)', () => {
    it('follows the server while nothing is being edited', () => {
        const incoming = trigger({ patternValue: '!weather', updatedAt: '2026-10-27T01:00:00.000Z' });
        const next = rebaseDraftWith(messageTriggerDraftModel, trigger(), draftFromTrigger(trigger()), incoming);
        expect(next).toEqual({ base: incoming, draft: draftFromTrigger(incoming), conflict: false });
    });

    it('keeps the edits when only the enabled switch (or stats) changed underneath', () => {
        const draft = { ...draftFromTrigger(trigger()), title: 'forecast' };
        const toggled = trigger({ enabled: false, updatedAt: '2026-10-27T01:00:00.000Z' });
        const next = rebaseDraftWith(messageTriggerDraftModel, trigger(), draft, toggled);
        expect(next).toEqual({ base: toggled, draft, conflict: false });
        // the next save is based on the toggled version, so it is not stale
        expect(toPatchBody(next.base, next.draft)?.ifUpdatedAt).toBe('2026-10-27T01:00:00.000Z');
    });

    it('keeps the edits but flags a conflict when someone changed the edited fields', () => {
        const draft = { ...draftFromTrigger(trigger()), title: 'forecast' };
        const edited = trigger({ patternValue: '!wx', updatedAt: '2026-10-27T01:00:00.000Z' });
        const next = rebaseDraftWith(messageTriggerDraftModel, trigger(), draft, edited);
        expect(next).toEqual({ base: trigger(), draft, conflict: true });
    });
});

describe('keepEditsOnWith — "keep my edits" after a conflict', () => {
    it('applies only the fields I edited onto the latest version', () => {
        const draft = { ...draftFromTrigger(trigger()), title: 'forecast' };
        const latest = trigger({ patternValue: '!wx', updatedAt: '2026-10-27T02:00:00.000Z' });
        const merged = keepEditsOnWith(messageTriggerDraftModel, trigger(), draft, latest);
        expect(merged).toMatchObject({ title: 'forecast', patternValue: '!wx' });
        expect(toPatchBody(latest, merged)).toEqual({ title: 'forecast', ifUpdatedAt: '2026-10-27T02:00:00.000Z' });
    });

    it('my edit wins where we both changed a field', () => {
        const draft = { ...draftFromTrigger(trigger()), patternValue: '!mine' };
        const latest = trigger({ patternValue: '!theirs' });
        expect(keepEditsOnWith(messageTriggerDraftModel, trigger(), draft, latest).patternValue).toBe('!mine');
    });
});

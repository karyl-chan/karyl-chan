import { describe, expect, it } from 'vitest';
import { fieldsWithErrorLine, issuesByFormField, triggerFormField } from './message-trigger-check';

describe('fieldsWithErrorLine — only fields on screen take an error', () => {
    it('the card shows the target select, the pattern, the action and the description', () => {
        expect(fieldsWithErrorLine({ description: true })).toEqual(
            expect.arrayContaining(['title', 'description', 'target', 'patternValue', 'webhook.url'])
        );
    });

    it('a dialog has no description', () => {
        expect(fieldsWithErrorLine({ description: false })).not.toContain('description');
    });

    it('checkboxes and the pattern kind have no error line', () => {
        const fields = fieldsWithErrorLine({ description: true });
        for (const hidden of ['patternKind', 'stopOnMatch', 'ignoreBots'] as const) {
            expect(fields).not.toContain(hidden);
        }
    });
});

describe('triggerFormField — what the target select stands for', () => {
    it('where the trigger is and for whom all show on the target select', () => {
        for (const field of [
            'surface',
            'guildId',
            'channelId',
            'audienceKind',
            'audienceUserId',
            'audienceGroupName',
            'location',
        ]) {
            expect(triggerFormField(field)).toBe('target');
        }
    });

    it('every other field shows on itself', () => {
        expect(triggerFormField('patternValue')).toBe('patternValue');
        expect(triggerFormField('webhook.url')).toBe('webhook.url');
    });

    it('schema issues on several of those fields become one, the first', () => {
        const issues = issuesByFormField({
            guildId: { keyword: 'pattern' },
            channelId: { keyword: 'required' },
            title: { keyword: 'minLength', limit: 1 },
        });
        expect(issues).toEqual({ target: { keyword: 'pattern' }, title: { keyword: 'minLength', limit: 1 } });
    });
});

import { describe, expect, it } from 'vitest';
import { replyPreview } from './reply-preview';

const link = (label: string, url: string) => ({ type: 1 as const, components: [{ type: 2 as const, style: 5 as const, label, url }] });

describe('replyPreview — what the test-fire reply would look like (#140)', () => {
    it('summarises content, embeds and link buttons', () => {
        const p = replyPreview(
            { content: 'hi', embeds: [{ title: 'Card' }, { description: 'no title' }], components: [link('Log in', 'https://x.example/l')] },
            'command'
        );
        expect(p).toEqual({
            content: 'hi',
            embedTitles: ['Card', null],
            buttons: [{ label: 'Log in', url: 'https://x.example/l' }],
            audience: 'invoker',
            empty: false,
        });
    });

    it('says who would see it, per trigger', () => {
        expect(replyPreview({ content: 'x' }, 'command').audience).toBe('invoker');
        expect(replyPreview({ content: 'x', ephemeral: false }, 'command').audience).toBe('channel');
        expect(replyPreview({ content: 'x' }, 'guild').audience).toBe('channel');
        expect(replyPreview({ content: 'x', ephemeral: true }, 'guild').audience).toBe('author_dm');
        expect(replyPreview({ content: 'x', ephemeral: false }, 'bot_dm').audience).toBe('dm');
        expect(replyPreview({ content: 'x', ephemeral: true }, 'bot_dm').audience).toBe('dm');
    });

    it('an empty reply is empty', () => {
        expect(replyPreview({ ephemeral: true }, 'guild').empty).toBe(true);
    });
});

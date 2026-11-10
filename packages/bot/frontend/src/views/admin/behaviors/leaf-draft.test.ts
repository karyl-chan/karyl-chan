import { describe, expect, it } from 'vitest';
import { draftFromLeaf, emptyLeafDraft, leafBody, leafPatch } from './leaf-draft';
import { savedLeaf } from './behavior-test-support';

const sub = savedLeaf({ id: 22, subcommand: 'wake', title: 'Wake', leafDescription: 'Wake a host' });

describe('leaf draft', () => {
    it('an untouched draft changes nothing', () => {
        expect(leafPatch(savedLeaf(), draftFromLeaf(savedLeaf()))).toBeNull();
        expect(leafPatch(sub, draftFromLeaf(sub))).toBeNull();
    });

    it('a PATCH carries only the changed fields and the version it is based on', () => {
        const draft = {
            ...draftFromLeaf(sub),
            leafDescription: '  Wake it up ',
            options: [{ type: 'string' as const, name: ' host ', description: ' Host name ', required: true }],
        };
        expect(leafPatch(sub, draft)).toEqual({
            leafDescription: 'Wake it up',
            options: [{ type: 'string', name: 'host', description: 'Host name', required: true }],
            ifUpdatedAt: '2026-10-27T00:00:00.000Z',
        });
    });

    it("an empty subcommand description falls back to the title (null), Discord's way", () => {
        expect(leafPatch(sub, { ...draftFromLeaf(sub), leafDescription: '' })).toMatchObject({ leafDescription: null });
    });

    it('the whole webhook goes when its URL or authentication changed', () => {
        expect(leafPatch(sub, { ...draftFromLeaf(sub), authMode: 'none' })).toMatchObject({
            webhook: { url: 'https://hook.example/s', authMode: null },
        });
    });

    it('the root leaf never sends a path or a subcommand description', () => {
        const draft = { ...draftFromLeaf(savedLeaf()), title: 'Uptime' };
        expect(leafPatch(savedLeaf(), draft)).toEqual({ title: 'Uptime', ifUpdatedAt: '2026-10-27T00:00:00.000Z' });
    });

    it('a new subcommand starts empty with an HMAC webhook', () => {
        expect(leafBody(emptyLeafDraft())).toEqual({
            subcommand: '',
            title: '',
            description: '',
            leafDescription: null,
            options: [],
            replyVisibility: null,
            webhook: { url: '', authMode: 'hmac' },
        });
    });

    it('carries the reply default, and a change to it is a patch', () => {
        const saved = savedLeaf({ replyVisibility: 'public' });
        const draft = draftFromLeaf(saved);
        expect(leafBody(draft).replyVisibility).toBe('public');
        expect(leafPatch(saved, { ...draft, replyVisibility: null })).toEqual({
            replyVisibility: null,
            ifUpdatedAt: saved.updatedAt,
        });
    });
});

describe('leaf draft — a plugin action (#203)', () => {
    const bound = savedLeaf({ actionSource: 'plugin', webhook: null, pluginAction: { pluginKey: 'dice', actionKey: 'roll' } });

    it('a bound leaf reads back as its binding, with a fresh webhook side kept aside', () => {
        const draft = draftFromLeaf(bound);
        expect(draft).toMatchObject({ actionSource: 'plugin', pluginKey: 'dice', actionKey: 'roll', webhookUrl: '', authMode: 'hmac' });
        expect(leafBody(draft)).toMatchObject({ pluginAction: { pluginKey: 'dice', actionKey: 'roll' } });
        expect(leafBody(draft)).not.toHaveProperty('webhook');
        expect(leafPatch(bound, draft)).toBeNull();
    });

    it('re-binding sends the new binding; switching source sends the other kind alone', () => {
        expect(leafPatch(bound, { ...draftFromLeaf(bound), actionKey: 'flip' })).toEqual({
            pluginAction: { pluginKey: 'dice', actionKey: 'flip' },
            ifUpdatedAt: '2026-10-27T00:00:00.000Z',
        });
        const toWebhook = { ...draftFromLeaf(bound), actionSource: 'webhook' as const, webhookUrl: 'https://hook.example/n' };
        expect(leafPatch(bound, toWebhook)).toEqual({
            webhook: { url: 'https://hook.example/n', authMode: 'hmac' },
            ifUpdatedAt: '2026-10-27T00:00:00.000Z',
        });
        const toPlugin = { ...draftFromLeaf(savedLeaf()), actionSource: 'plugin' as const, pluginKey: 'dice', actionKey: 'roll' };
        expect(leafPatch(savedLeaf(), toPlugin)).toEqual({
            pluginAction: { pluginKey: 'dice', actionKey: 'roll' },
            ifUpdatedAt: '2026-10-27T00:00:00.000Z',
        });
    });

    it('switching to a plugin action and back changes nothing', () => {
        const draft = { ...draftFromLeaf(savedLeaf()), actionSource: 'plugin' as const, pluginKey: 'dice', actionKey: 'roll' };
        expect(leafPatch(savedLeaf(), { ...draft, actionSource: 'webhook' })).toBeNull();
    });
});

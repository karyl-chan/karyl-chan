import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ getBehaviorSchemas: vi.fn() }));
vi.mock('../../../api/behavior', () => api);

import { checkLeafDraft } from './leaf-check';
import { draftFromLeaf, emptyLeafDraft } from './leaf-draft';
import { COMMAND_LEAF_SCHEMA, COMMAND_SCHEMA, savedLeaf } from './behavior-test-support';

const t = (key: string) => key;

beforeEach(() => {
    api.getBehaviorSchemas.mockReset().mockResolvedValue({ command: COMMAND_SCHEMA, commandLeaf: COMMAND_LEAF_SCHEMA });
});

describe('checkLeafDraft', () => {
    it('a saved leaf as it is passes', async () => {
        expect(await checkLeafDraft(t, draftFromLeaf(savedLeaf()), 'root')).toEqual({ fields: {}, general: null });
    });

    it('an added subcommand needs its name and a webhook', async () => {
        const { fields } = await checkLeafDraft(t, { ...emptyLeafDraft(), title: 'Wake' }, 'add');
        expect(fields.subcommand).toBe('behaviors.validation.format');
        expect(fields['webhook.url']).toBe('behaviors.validation.required');
    });

    it("an option's format, on its row", async () => {
        const draft = {
            ...draftFromLeaf(savedLeaf()),
            options: [{ type: 'string' as const, name: 'Host', description: 'h', required: false }],
        };
        expect((await checkLeafDraft(t, draft, 'root')).fields['options.0.name']).toBe('behaviors.validation.format');
    });

    it("Discord's option rules: required options first, names unique", async () => {
        const draft = {
            ...draftFromLeaf(savedLeaf()),
            options: [
                { type: 'string' as const, name: 'a', description: 'a', required: false },
                { type: 'string' as const, name: 'b', description: 'b', required: true },
                { type: 'string' as const, name: 'a', description: 'c', required: false },
            ],
        };
        const { fields } = await checkLeafDraft(t, draft, 'root');
        expect(fields['options.1.required']).toBe('behaviors.command.optionRule.requiredAfterOptional');
        expect(fields['options.2.name']).toBe('behaviors.command.optionRule.duplicateName');
    });
});

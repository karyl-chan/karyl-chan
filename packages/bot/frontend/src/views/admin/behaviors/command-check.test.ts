import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ getBehaviorSchemas: vi.fn() }));
vi.mock('../../../api/behavior', () => api);

import { checkCommandDraft, commandFieldsWithErrorLine } from './command-check';
import { draftFromCommand, withRegistration } from './command-draft';
import { COMMAND_SCHEMA, savedCommand } from './behavior-test-support';

const t = (key: string) => key;

beforeEach(() => {
    api.getBehaviorSchemas.mockReset().mockResolvedValue({ command: COMMAND_SCHEMA });
});

describe('checkCommandDraft — what the server would refuse, before sending', () => {
    it('a valid draft has no errors', async () => {
        expect(await checkCommandDraft(t, draftFromCommand(savedCommand()))).toEqual({ fields: {}, general: null });
    });

    it('the server schema: name format, description length, at least one context', async () => {
        const draft = { ...draftFromCommand(savedCommand()), name: 'Bad Name', description: 'x'.repeat(101), contexts: [] };
        const { fields } = await checkCommandDraft(t, draft);
        expect(fields.name).toBe('behaviors.validation.format');
        expect(fields.description).toBe('behaviors.validation.tooLong');
        expect(fields.contexts).toBe('behaviors.validation.tooFew');
    });

    it("Discord's visibility rules, on the field they are about", async () => {
        const draft = { ...draftFromCommand(savedCommand()), contexts: ['PrivateChannel' as const] };
        const { fields } = await checkCommandDraft(t, draft);
        expect(fields.contexts).toBe('behaviors.command.rule.privateChannelNeedsUserInstall');
    });

    it('a server command needs its server', async () => {
        const draft = withRegistration(draftFromCommand(savedCommand()), 'guild');
        const { fields } = await checkCommandDraft(t, draft);
        expect(fields.guildId).toBeDefined();
    });

    it('`login` is reserved for the system login', async () => {
        const { fields } = await checkCommandDraft(t, { ...draftFromCommand(savedCommand()), name: 'login' });
        expect(fields.name).toBe('behaviors.command.reservedName');
    });

    it('without the schema the server stays the only check, but the mirrored rules still apply', async () => {
        api.getBehaviorSchemas.mockRejectedValue(new Error('offline'));
        const draft = { ...draftFromCommand(savedCommand()), name: 'Bad Name', contexts: ['PrivateChannel' as const] };
        const { fields } = await checkCommandDraft(t, draft);
        expect(fields.name).toBeUndefined();
        expect(fields.contexts).toBe('behaviors.command.rule.privateChannelNeedsUserInstall');
    });
});

describe('commandFieldsWithErrorLine', () => {
    it('the server field is only on screen for a server command', () => {
        const global = draftFromCommand(savedCommand());
        expect(commandFieldsWithErrorLine(global)).not.toContain('guildId');
        expect(commandFieldsWithErrorLine(withRegistration(global, 'guild'))).toContain('guildId');
    });
});

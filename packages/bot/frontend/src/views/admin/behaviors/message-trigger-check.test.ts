import { describe, expect, it } from 'vitest';
import { fieldsWithErrorLine, type TriggerFormLayout } from './message-trigger-check';
import { emptyDraft } from './message-trigger-draft';

const GUILD = '123456789012345678';
const CHANNEL = '223456789012345678';

const card: TriggerFormLayout = {
    kinds: ['bot_dm', 'guild_all', 'guild', 'channel'],
    lockGuild: false,
    lockChannel: false,
    description: true,
};

describe('fieldsWithErrorLine — only fields on screen take an error', () => {
    it('the card shows the location picker, ids and description', () => {
        const fields = fieldsWithErrorLine(emptyDraft({ kind: 'channel', guildId: GUILD, channelId: CHANNEL }), card);
        expect(fields).toEqual(
            expect.arrayContaining(['title', 'description', 'surface', 'guildId', 'channelId', 'patternValue', 'webhook.url'])
        );
        expect(fields).not.toContain('audienceKind');
    });

    it('a section-fixed channel shows neither picker nor ids, and the dialog has no description', () => {
        const dialog: TriggerFormLayout = { kinds: ['channel'], lockGuild: true, lockChannel: true, description: false };
        const fields = fieldsWithErrorLine(emptyDraft({ kind: 'channel', guildId: GUILD, channelId: CHANNEL }), dialog);
        for (const hidden of ['surface', 'guildId', 'channelId', 'description'] as const) {
            expect(fields).not.toContain(hidden);
        }
    });

    it('checkboxes and the pattern kind have no error line', () => {
        const fields = fieldsWithErrorLine(emptyDraft({ kind: 'guild_all' }), card);
        for (const hidden of ['patternKind', 'stopOnMatch', 'ignoreBots'] as const) {
            expect(fields).not.toContain(hidden);
        }
    });

    it('audience fields only in bot DMs, and only the one in use', () => {
        const dm = { ...emptyDraft({ kind: 'bot_dm' }), audienceKind: 'group' as const };
        const fields = fieldsWithErrorLine(dm, card);
        expect(fields).toEqual(expect.arrayContaining(['audienceKind', 'audienceGroupName']));
        expect(fields).not.toContain('audienceUserId');
    });
});

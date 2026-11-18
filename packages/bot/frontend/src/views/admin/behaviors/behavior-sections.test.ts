import { describe, expect, it } from 'vitest';
import { itemKey, parseSection } from './behavior-sections';

describe('parseSection', () => {
    it('reads every section key', () => {
        expect(parseSection('app')).toEqual({ kind: 'app' });
        expect(parseSection('bot_dm')).toEqual({ kind: 'bot_dm' });
        expect(parseSection('guild:all')).toEqual({ kind: 'guild_all' });
        expect(parseSection('guild:123')).toEqual({ kind: 'guild', guildId: '123' });
        expect(parseSection('channel:123:456')).toEqual({
            kind: 'channel',
            guildId: '123',
            channelId: '456',
        });
    });
});

describe('itemKey', () => {
    it('keeps commands and behaviors apart: they are numbered separately', () => {
        expect(itemKey({ kind: 'command', id: 4 })).toBe('command:4');
        expect(itemKey({ kind: 'message', id: 4 })).toBe('message:4');
    });
});

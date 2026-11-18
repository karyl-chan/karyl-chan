import { describe, expect, it } from 'vitest';
import { locationKey, locationKindOf } from './message-trigger-location';

const GUILD = '123456789012345678';
const CHANNEL = '223456789012345678';

describe('message trigger locations', () => {
    it('a trigger says where it is', () => {
        expect(locationKindOf({ surface: 'bot_dm', guildId: null, channelId: null })).toBe('bot_dm');
        expect(locationKindOf({ surface: 'guild', guildId: null, channelId: null })).toBe('guild_all');
        expect(locationKindOf({ surface: 'guild', guildId: GUILD, channelId: null })).toBe('guild');
        expect(locationKindOf({ surface: 'guild', guildId: GUILD, channelId: CHANNEL })).toBe('channel');
    });

    it('a location has one key', () => {
        expect(locationKey({ kind: 'bot_dm' })).toBe('bot_dm');
        expect(locationKey({ kind: 'guild_all' })).toBe('guild:all');
        expect(locationKey({ kind: 'guild', guildId: GUILD })).toBe(`guild:${GUILD}`);
        expect(locationKey({ kind: 'channel', guildId: GUILD, channelId: CHANNEL })).toBe(`channel:${GUILD}:${CHANNEL}`);
    });
});

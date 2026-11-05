import { describe, expect, it } from 'vitest';
import { locationKindOf, locationOfSection, messageTriggerLocationOf } from './message-trigger-location';

const GUILD = '123456789012345678';
const CHANNEL = '223456789012345678';

describe('message trigger locations', () => {
    it('a trigger says where it is', () => {
        expect(locationKindOf({ surface: 'bot_dm', guildId: null, channelId: null })).toBe('bot_dm');
        expect(locationKindOf({ surface: 'guild', guildId: null, channelId: null })).toBe('guild_all');
        expect(locationKindOf({ surface: 'guild', guildId: GUILD, channelId: null })).toBe('guild');
        expect(locationKindOf({ surface: 'guild', guildId: GUILD, channelId: CHANNEL })).toBe('channel');
    });

    it('App 指令 holds no message triggers: it has no location to reorder', () => {
        expect(locationOfSection('app')).toBeNull();
        expect(messageTriggerLocationOf('app')).toBeNull();
    });

    it('every other section is exactly one Message Trigger Location', () => {
        expect(messageTriggerLocationOf('bot_dm')).toBe('bot_dm');
        expect(messageTriggerLocationOf('guild:all')).toBe('guild:all');
        expect(messageTriggerLocationOf(`guild:${GUILD}`)).toBe(`guild:${GUILD}`);
        expect(locationOfSection(`channel:${GUILD}:${CHANNEL}`)).toEqual({ kind: 'channel', guildId: GUILD, channelId: CHANNEL });
    });
});

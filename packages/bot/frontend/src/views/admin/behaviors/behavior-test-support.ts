import { createI18n } from 'vue-i18n';
import type { CommandLeafView, CommandView, MessageTriggerView } from '../../../api/behavior';

/**
 * Shared fixtures for the behaviors page's component tests (not a test
 * file itself). Each test file still declares its own `vi.mock`s.
 */

/** i18n that answers with the key, so tests assert on keys. */
export function keyI18n() {
    return createI18n({ legacy: false, locale: 'en', missingWarn: false, fallbackWarn: false, messages: { en: {} } });
}

/** useBreakpoint (menus, selects, modals) reads matchMedia, which jsdom lacks. */
export function stubMatchMedia(): void {
    window.matchMedia ??= ((query: string) => ({
        matches: false,
        media: query,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        addListener: () => undefined,
        removeListener: () => undefined,
        onchange: null,
        dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
}

/** The schema shape GET /api/behaviors/schema serves, trimmed to what the tests touch. */
export const MESSAGE_TRIGGER_SCHEMA = {
    type: 'object',
    properties: {
        title: { type: 'string', minLength: 1, maxLength: 100, pattern: '\\S' },
        patternValue: { type: 'string', minLength: 1, maxLength: 500 },
        webhook: { type: 'object', properties: { url: { type: 'string', minLength: 1 } }, required: ['url'] },
    },
    required: ['title', 'patternValue', 'webhook'],
};

/** A saved bot DM message trigger, id 7, HMAC webhook. */
export function savedTrigger(overrides: Partial<MessageTriggerView> = {}): MessageTriggerView {
    return {
        kind: 'message',
        id: 7,
        title: 'weather',
        description: '',
        enabled: true,
        sortOrder: 0,
        systemKey: null,
        actionSource: 'webhook',
        webhook: { url: 'https://hook.example/w', authMode: 'hmac', secretSet: true, previousSecretExpiresAt: null },
        stats: null,
        updatedAt: '2026-10-27T00:00:00.000Z',
        surface: 'bot_dm',
        guildId: null,
        channelId: null,
        patternKind: 'startswith',
        patternValue: '!w',
        stopOnMatch: false,
        ignoreBots: true,
        audienceKind: 'all',
        audienceUserId: null,
        audienceGroupName: null,
        section: 'bot_dm',
        ...overrides,
    };
}

/** A leaf of a saved command: the root leaf, id 21, HMAC webhook. */
export function savedLeaf(overrides: Partial<CommandLeafView> = {}): CommandLeafView {
    return {
        id: 21,
        title: 'Status',
        description: '',
        enabled: true,
        sortOrder: 0,
        systemKey: null,
        actionSource: 'webhook',
        webhook: { url: 'https://hook.example/s', authMode: 'hmac', secretSet: true, previousSecretExpiresAt: null },
        stats: null,
        updatedAt: '2026-10-27T00:00:00.000Z',
        subcommandGroup: '',
        subcommand: '',
        leafDescription: null,
        options: [],
        ...overrides,
    };
}

/** A saved global command, id 4, `/status` usable only in bot DMs, with one root leaf. */
export function savedCommand(overrides: Partial<CommandView> = {}): CommandView {
    return {
        kind: 'command',
        id: 4,
        name: 'status',
        description: 'Service status',
        registration: 'global',
        guildId: null,
        integrationTypes: ['guild_install'],
        contexts: ['BotDM'],
        defaultMemberPermissions: null,
        isSystem: false,
        section: 'bot_dm',
        updatedAt: '2026-10-27T00:00:00.000Z',
        leaves: [savedLeaf()],
        ...overrides,
    };
}

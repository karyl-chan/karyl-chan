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

/** The command schema GET /api/behaviors/schema serves, trimmed to what the tests touch. */
const NON_BLANK = '\\S';
const SNOWFLAKE = '^\\d{17,20}$';

export const COMMAND_SCHEMA = {
    type: 'object',
    properties: {
        name: { type: 'string', pattern: '^[a-z0-9_-]{1,32}$' },
        description: { type: 'string', minLength: 1, maxLength: 100, pattern: NON_BLANK },
        guildId: { anyOf: [{ type: 'string', pattern: SNOWFLAKE }, { type: 'null' }] },
        contexts: { type: 'array', minItems: 1, items: { enum: ['Guild', 'BotDM', 'PrivateChannel'] } },
        integrationTypes: { type: 'array', minItems: 1, items: { enum: ['guild_install', 'user_install'] } },
        leaves: { type: 'array', minItems: 1, items: leafSchemaItems() },
    },
    required: ['name', 'description', 'registration', 'leaves'],
};

function leafSchemaItems() {
    return {
        type: 'object',
        properties: {
            subcommand: { anyOf: [{ const: '' }, { type: 'string', pattern: '^[a-z0-9_-]{1,32}$' }] },
            title: { type: 'string', minLength: 1, maxLength: 100, pattern: NON_BLANK },
            leafDescription: { anyOf: [{ type: 'string', minLength: 1, maxLength: 100 }, { type: 'null' }] },
            options: {
                type: 'array',
                maxItems: 25,
                items: {
                    type: 'object',
                    properties: {
                        name: { type: 'string', pattern: '^[a-z0-9_-]{1,32}$' },
                        description: { type: 'string', minLength: 1, maxLength: 100, pattern: NON_BLANK },
                    },
                },
            },
            webhook: { type: 'object', properties: { url: { type: 'string', minLength: 1 } }, required: ['url'] },
        },
        required: ['title', 'webhook'],
    };
}

/** The added-subcommand schema GET /api/behaviors/schema serves, trimmed likewise. */
export const COMMAND_LEAF_SCHEMA = {
    ...leafSchemaItems(),
    properties: { ...leafSchemaItems().properties, subcommand: { type: 'string', pattern: '^[a-z0-9_-]{1,32}$' } },
    required: ['subcommand', 'title', 'webhook'],
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
        replyVisibility: null,
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
        replyVisibility: null,
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

/** The System Behavior (login) on its default trigger: bot DM `!login`, id 1. */
export function systemLoginMessage(overrides: Partial<MessageTriggerView> = {}): MessageTriggerView {
    return savedTrigger({
        id: 1,
        title: '發送登入連結',
        systemKey: 'admin-login',
        actionSource: 'builtin',
        webhook: null,
        sortOrder: -1000,
        patternValue: '!login',
        stopOnMatch: true,
        ...overrides,
    });
}

/** The System Behavior on a command: `/login`, global, bot DMs only (command id 9, leaf id 1). */
export function systemLoginCommand(overrides: Partial<CommandView> = {}): CommandView {
    return savedCommand({
        id: 9,
        name: 'login',
        description: '取得 admin 後台一次性登入連結(僅授權使用者)',
        isSystem: true,
        leaves: [
            savedLeaf({
                id: 1,
                title: '發送登入連結',
                systemKey: 'admin-login',
                actionSource: 'builtin',
                webhook: null,
                sortOrder: -1000,
            }),
        ],
        ...overrides,
    });
}

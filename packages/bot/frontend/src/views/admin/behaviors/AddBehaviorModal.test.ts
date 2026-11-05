import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import type { BehaviorSection, MessageTriggerView } from '../../../api/behavior';
import { ApiError } from '../../../api/client';

const api = vi.hoisted(() => ({ createMessageTrigger: vi.fn(), createBehaviorCommand: vi.fn(), getBehaviorSchemas: vi.fn() }));
vi.mock('../../../api/behavior', () => api);
vi.mock('../../../api/guilds', () => ({ listGuilds: vi.fn(async () => []), listGuildTextChannels: vi.fn(async () => []) }));

import AddBehaviorModal from './AddBehaviorModal.vue';
import { COMMAND_LEAF_SCHEMA, COMMAND_SCHEMA, keyI18n, savedCommand, stubMatchMedia } from './behavior-test-support';

const i18n = keyI18n();
const GUILD = '123456789012345678';
const CHANNEL = '223456789012345678';

beforeAll(stubMatchMedia);

const mounted: VueWrapper[] = [];
afterEach(() => mounted.splice(0).forEach((w) => w.unmount()));

beforeEach(() => {
    setActivePinia(createPinia());
    api.createMessageTrigger.mockReset();
    api.createBehaviorCommand.mockReset();
    api.getBehaviorSchemas
        .mockReset()
        .mockResolvedValue({ messageTrigger: { type: 'object' }, command: COMMAND_SCHEMA, commandLeaf: COMMAND_LEAF_SCHEMA });
});

function open(section: BehaviorSection) {
    const wrapper = mount(AddBehaviorModal, {
        props: { visible: true, section, guildNames: new Map() },
        global: { plugins: [i18n] },
        attachTo: document.body,
    });
    mounted.push(wrapper);
    return wrapper;
}

/** The dialog is teleported to <body>. */
const $ = (selector: string) => document.body.querySelector<HTMLElement>(selector);
const $$ = (selector: string) => [...document.body.querySelectorAll<HTMLElement>(selector)];

function radio(kind: 'command' | 'message') {
    return $(`[data-test="kind-${kind}"]`)! as HTMLButtonElement;
}

async function type(label: string, value: string) {
    const field = $$('.app-field').find((f) => f.querySelector('.app-field__label')?.textContent === label)!;
    const input = field.querySelector('input')!;
    input.value = value;
    input.dispatchEvent(new Event('input'));
    await flushPromises();
}

describe('AddBehaviorModal — only what the section can hold (board 2)', () => {
    it('in a channel, commands are disabled with the reason shown', async () => {
        open(`channel:${GUILD}:${CHANNEL}`);
        await flushPromises();
        expect(radio('command').disabled).toBe(true);
        expect(radio('message').getAttribute('aria-checked')).toBe('true');
        expect($$('[data-test="denied"]').map((p) => p.textContent)).toEqual(['behaviors.add.reason.commandInChannel']);
    });

    it('in App 指令, message triggers are disabled with the reason shown', async () => {
        open('app');
        await flushPromises();
        expect(radio('message').disabled).toBe(true);
        expect($$('[data-test="denied"]').map((p) => p.textContent)).toEqual(['behaviors.add.reason.messageInApp']);
        expect(radio('command').getAttribute('aria-checked')).toBe('true');
    });
});

describe('AddBehaviorModal — creating a message trigger', () => {
    it('creates it where the section is, then shows the generated secret once', async () => {
        const created = { id: 9, section: 'bot_dm' } as MessageTriggerView;
        api.createMessageTrigger.mockResolvedValue({ behavior: created, secret: 's3cret' });
        const wrapper = open('bot_dm');
        await flushPromises();

        await type('behaviors.add.name', 'weather');
        await type('behaviors.trigger.patternValue', '!w');
        await type('behaviors.action.url', 'https://hook.example/w');
        $('[data-test="create"]')!.click();
        await flushPromises();

        expect(api.createMessageTrigger).toHaveBeenCalledWith(
            expect.objectContaining({
                title: 'weather',
                surface: 'bot_dm',
                patternValue: '!w',
                audienceKind: 'all',
                webhook: { url: 'https://hook.example/w', authMode: 'hmac' },
            })
        );
        expect(wrapper.emitted('created')).toEqual([[created]]);
        expect($('[data-test="secret-value"]')!.textContent).toBe('s3cret');
        expect(wrapper.emitted('close')).toBeUndefined();

        $('[data-test="done"]')!.click();
        await flushPromises();
        expect(wrapper.emitted('close')).toHaveLength(1);
    });

    it('keeps the secret on screen while the page follows the new trigger elsewhere', async () => {
        api.createMessageTrigger.mockResolvedValue({
            behavior: { id: 9, section: `guild:${GUILD}` },
            secret: 's3cret',
        });
        const wrapper = open('guild:all');
        await flushPromises();
        await type('behaviors.add.name', 'q');
        await type('behaviors.trigger.patternValue', '?');
        await type('behaviors.action.url', 'https://hook.example/q');
        $('[data-test="create"]')!.click();
        await flushPromises();

        await wrapper.setProps({ section: `guild:${GUILD}` });
        expect($('[data-test="secret-value"]')!.textContent).toBe('s3cret');
    });

    it('closes right away when no secret was generated', async () => {
        api.createMessageTrigger.mockResolvedValue({ behavior: { id: 9, section: 'bot_dm' } });
        const wrapper = open('bot_dm');
        await flushPromises();
        await type('behaviors.add.name', 'weather');
        await type('behaviors.trigger.patternValue', '!w');
        await type('behaviors.action.url', 'https://hook.example/w');
        $('[data-test="create"]')!.click();
        await flushPromises();
        expect(wrapper.emitted('close')).toHaveLength(1);
    });

    it('a refusal naming a field shows on that field and keeps the dialog open', async () => {
        api.createMessageTrigger.mockRejectedValue(
            new ApiError(400, 'http://x is refused (https_required)', 'validation_failed', 'webhook.url')
        );
        const wrapper = open('bot_dm');
        await flushPromises();
        await type('behaviors.add.name', 'weather');
        await type('behaviors.trigger.patternValue', '!w');
        await type('behaviors.action.url', 'http://x');
        $('[data-test="create"]')!.click();
        await flushPromises();
        const url = $$('.app-field').find((f) => f.textContent?.includes('behaviors.action.url'))!;
        expect(url.querySelector('.app-field__error')!.textContent).toContain('https_required');
        expect(wrapper.emitted('created')).toBeUndefined();
    });

    it('a refusal on a field the section fixes is shown as a general error', async () => {
        api.createMessageTrigger.mockRejectedValue(
            new ApiError(400, 'guildId must be a Discord id', 'validation_failed', 'guildId')
        );
        const wrapper = open(`guild:${GUILD}`);
        await flushPromises();
        await type('behaviors.add.name', 'q');
        await type('behaviors.trigger.patternValue', '?');
        await type('behaviors.action.url', 'https://hook.example/q');
        $('[data-test="create"]')!.click();
        await flushPromises();
        expect($('[role="alert"].error')!.textContent).toContain('behaviors.errors.withDetail');
        expect(wrapper.emitted('created')).toBeUndefined();
    });

    it('in a channel section the channel is fixed, not an input', async () => {
        open(`channel:${GUILD}:${CHANNEL}`);
        await flushPromises();
        const labels = $$('.app-field__label').map((l) => l.textContent);
        expect(labels).not.toContain('behaviors.location.channelPicker');
        expect(labels).not.toContain('behaviors.location.guildPicker');
    });
});

describe('AddBehaviorModal — creating a command (board 2)', () => {
    async function fillCommand(name = 'status') {
        await type('behaviors.add.name', 'Service status');
        await type('behaviors.command.name', name);
        await type('behaviors.command.description', 'Show service status');
        await type('behaviors.action.url', 'https://hook.example/s');
    }

    function fieldError(label: string): string | null | undefined {
        const field = $$('.app-field').find((f) => f.querySelector('.app-field__label')?.textContent === label)!;
        return field.querySelector('.app-field__error')?.textContent;
    }

    it('creates a root command with the visibility of its section, then shows the registration and the secret once', async () => {
        const created = savedCommand({ id: 9 });
        api.createBehaviorCommand.mockResolvedValue({
            command: created,
            registration: { status: 'deferred', reason: 'the bot is not connected to Discord' },
            secrets: [{ behaviorId: 21, subcommand: '', secret: 'cmd-s3cret' }],
        });
        const wrapper = open('bot_dm');
        await flushPromises();
        radio('command').click();
        await flushPromises();
        expect($('[data-test="command-preset"]')!.textContent).toContain('behaviors.card.context.BotDM');
        await fillCommand();
        $('[data-test="create"]')!.click();
        await flushPromises();

        expect(api.createBehaviorCommand).toHaveBeenCalledWith({
            name: 'status',
            description: 'Show service status',
            registration: 'global',
            guildId: null,
            integrationTypes: ['guild_install'],
            contexts: ['BotDM'],
            defaultMemberPermissions: null,
            leaves: [
                {
                    subcommand: '',
                    title: 'Service status',
                    replyVisibility: null,
                    webhook: { url: 'https://hook.example/s', authMode: 'hmac' },
                },
            ],
        });
        expect(wrapper.emitted('created')).toEqual([[created]]);
        expect($('[data-test="registration-result"]')!.getAttribute('data-tone')).toBe('warn');
        expect($('[data-test="secret-value"]')!.textContent).toBe('cmd-s3cret');
        expect(wrapper.emitted('close')).toBeUndefined();
    });

    it('in one server it creates a server command there', async () => {
        api.createBehaviorCommand.mockResolvedValue({ command: savedCommand(), registration: { status: 'registered', targets: [] } });
        open(`guild:${GUILD}`);
        await flushPromises();
        radio('command').click();
        await flushPromises();
        await fillCommand();
        $('[data-test="create"]')!.click();
        await flushPromises();
        expect(api.createBehaviorCommand).toHaveBeenCalledWith(
            expect.objectContaining({ registration: 'guild', guildId: GUILD, contexts: ['Guild'], integrationTypes: ['guild_install'] })
        );
    });

    it('a name taken in the namespace shows on the command name field', async () => {
        api.createBehaviorCommand.mockRejectedValue(
            new ApiError(409, '/status is already taken by a command of plugin #7 (globally)', 'name_conflict', 'name')
        );
        const wrapper = open('bot_dm');
        await flushPromises();
        radio('command').click();
        await flushPromises();
        await fillCommand();
        $('[data-test="create"]')!.click();
        await flushPromises();
        expect(fieldError('behaviors.command.name')).toContain('plugin #7');
        expect(wrapper.emitted('created')).toBeUndefined();
    });

    it('the name login is reserved: refused before sending', async () => {
        open('app');
        await flushPromises();
        await fillCommand('login');
        $('[data-test="create"]')!.click();
        await flushPromises();
        expect(api.createBehaviorCommand).not.toHaveBeenCalled();
        expect(fieldError('behaviors.command.name')).toBe('behaviors.command.reservedName');
    });

    it('a leaf field the server refuses lands on the dialog field it came from', async () => {
        api.createBehaviorCommand.mockRejectedValue(
            new ApiError(400, 'http://x is refused (https_required)', 'validation_failed', 'leaves.0.webhook.url')
        );
        open('bot_dm');
        await flushPromises();
        radio('command').click();
        await flushPromises();
        await fillCommand();
        $('[data-test="create"]')!.click();
        await flushPromises();
        expect(fieldError('behaviors.action.url')).toContain('https_required');
    });

    it('a command Discord refuses is not created and says why', async () => {
        api.createBehaviorCommand.mockRejectedValue(
            new ApiError(502, 'Discord did not accept /status: Invalid Form Body', 'registration_failed', null, { targets: [] })
        );
        const wrapper = open('bot_dm');
        await flushPromises();
        radio('command').click();
        await flushPromises();
        await fillCommand();
        $('[data-test="create"]')!.click();
        await flushPromises();
        expect($('[data-test="registration-result"]')!.textContent).toContain('Invalid Form Body');
        expect(wrapper.emitted('created')).toBeUndefined();
    });

    it('a refusal whose undo failed left the command stored: the list is reloaded so it shows', async () => {
        api.createBehaviorCommand.mockRejectedValue(
            new ApiError(
                502,
                'Discord did not accept /status: Invalid Form Body; restoring the previous version failed, so the change is still stored — resync or edit the command',
                'registration_failed',
                null,
                { targets: [] }
            )
        );
        const wrapper = open('bot_dm');
        await flushPromises();
        radio('command').click();
        await flushPromises();
        await fillCommand();
        $('[data-test="create"]')!.click();
        await flushPromises();
        expect($('[data-test="registration-result"]')!.textContent).toContain('still stored');
        expect(wrapper.emitted('reload')).toHaveLength(1);
    });
});

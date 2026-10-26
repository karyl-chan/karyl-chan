import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import type { BehaviorSection, MessageTriggerView } from '../../../api/behavior';
import { ApiError } from '../../../api/client';

const api = vi.hoisted(() => ({ createMessageTrigger: vi.fn(), getBehaviorSchemas: vi.fn() }));
vi.mock('../../../api/behavior', () => api);
vi.mock('../../../api/guilds', () => ({ listGuilds: vi.fn(async () => []), listGuildTextChannels: vi.fn(async () => []) }));

import AddBehaviorModal from './AddBehaviorModal.vue';
import { keyI18n, stubMatchMedia } from './behavior-test-support';

const i18n = keyI18n();
const GUILD = '123456789012345678';
const CHANNEL = '223456789012345678';

beforeAll(stubMatchMedia);

const mounted: VueWrapper[] = [];
afterEach(() => mounted.splice(0).forEach((w) => w.unmount()));

beforeEach(() => {
    setActivePinia(createPinia());
    api.createMessageTrigger.mockReset();
    api.getBehaviorSchemas.mockReset().mockResolvedValue({ messageTrigger: { type: 'object' } });
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
        const reasons = $$('[data-test="denied"]').map((p) => p.textContent);
        expect(reasons).toContain('behaviors.add.reason.messageInApp');
        // commands belong here, but their form arrives with S6 (#138)
        expect(reasons).toContain('behaviors.add.reason.commandLater');
        expect(($('[data-test="create"]') as HTMLButtonElement).disabled).toBe(true);
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

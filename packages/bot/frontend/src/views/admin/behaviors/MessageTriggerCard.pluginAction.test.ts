import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import type { MessageTriggerView } from '../../../api/behavior';

const api = vi.hoisted(() => ({
    updateBehavior: vi.fn(),
    deleteBehavior: vi.fn(),
    testBehavior: vi.fn(),
    getBehaviorSchemas: vi.fn(),
    getPluginBehaviorActions: vi.fn(),
    rotateWebhookSecret: vi.fn(),
    getGroupMembers: vi.fn(),
    replaceGroupMembers: vi.fn(),
}));
vi.mock('../../../api/behavior', () => api);
vi.mock('../../../api/discord', () => ({ fetchUserSummaries: vi.fn(async () => []) }));
vi.mock('../../../api/guilds', () => ({ listGuilds: vi.fn(async () => []), listGuildTextChannels: vi.fn(async () => []) }));
vi.mock('@karyl-chan/ui', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@karyl-chan/ui')>()),
    useConfirm: () => ({ confirm: vi.fn() }),
}));

import MessageTriggerCard from './MessageTriggerCard.vue';
import { MESSAGE_TRIGGER_SCHEMA, keyI18n, savedTrigger, stubMatchMedia } from './behavior-test-support';

const i18n = keyI18n();

const mounted: VueWrapper[] = [];
afterEach(() => mounted.splice(0).forEach((w) => w.unmount()));

async function mountOpen(t: MessageTriggerView): Promise<VueWrapper> {
    const wrapper = mount(MessageTriggerCard, {
        props: { trigger: t, guildNames: new Map(), groupNames: [], groupUse: new Map(), commands: [] },
        global: { plugins: [i18n] },
        attachTo: document.body,
    });
    mounted.push(wrapper);
    await wrapper.find('.app-item-card__expander').trigger('click');
    await flushPromises();
    return wrapper;
}

/** Pick a value in one of the card's AppSelectFields (its options are teleported). */
async function choose(wrapper: VueWrapper, label: string, option: string) {
    const field = wrapper.findAll('label.field').find((f) => f.find('.field-label').text() === label)!;
    await field.find('button.select-trigger').trigger('click');
    await flushPromises();
    const item = [...document.querySelectorAll<HTMLElement>('li')].find((li) => li.textContent?.trim() === option)!;
    item.click();
    await flushPromises();
}

async function save(wrapper: VueWrapper) {
    await wrapper.find('form.editor').trigger('submit');
    await flushPromises();
}

const pluginTrigger = () =>
    savedTrigger({ actionSource: 'plugin', webhook: null, pluginAction: { pluginKey: 'dice', actionKey: 'roll' } });

beforeAll(stubMatchMedia);

beforeEach(() => {
    setActivePinia(createPinia());
    Object.values(api).forEach((fn) => fn.mockReset());
    api.getBehaviorSchemas.mockResolvedValue({ messageTrigger: MESSAGE_TRIGGER_SCHEMA });
    api.getPluginBehaviorActions.mockResolvedValue([
        {
            pluginKey: 'dice',
            pluginName: 'Dice',
            enabled: true,
            status: 'active',
            actions: [
                { key: 'roll', name: 'Roll dice', description: 'Rolls' },
                { key: 'flip', name: 'Flip a coin', description: 'Coin' },
            ],
        },
    ]);
    api.updateBehavior.mockImplementation(async (_id: number, patch: Record<string, unknown>) => ({
        behavior: { ...savedTrigger(), ...patch },
    }));
});

describe('MessageTriggerCard — the action source switch (#203)', () => {
    it('a webhook trigger switched to a plugin action saves the binding alone', async () => {
        const wrapper = await mountOpen(savedTrigger());
        expect(wrapper.find('[data-test="plugin-action-picker"]').exists()).toBe(false);

        await choose(wrapper, 'behaviors.action.source', 'behaviors.action.sourcePlugin');
        // the webhook's URL, authentication and secret make way for the picker
        expect(wrapper.find('input[inputmode="url"]').exists()).toBe(false);
        expect(wrapper.find('[data-test="plugin-action-picker"]').exists()).toBe(true);

        await choose(wrapper, 'behaviors.action.plugin.label', 'Flip a coin');
        await save(wrapper);

        expect(api.updateBehavior).toHaveBeenCalledWith(7, {
            pluginAction: { pluginKey: 'dice', actionKey: 'flip' },
            ifUpdatedAt: '2026-10-27T00:00:00.000Z',
        });
    });

    it('a plugin action needs one picked before it saves', async () => {
        const wrapper = await mountOpen(savedTrigger());
        await choose(wrapper, 'behaviors.action.source', 'behaviors.action.sourcePlugin');
        await save(wrapper);
        expect(api.updateBehavior).not.toHaveBeenCalled();
        expect(wrapper.find('[data-test="plugin-action-picker"]').text()).toContain('behaviors.validation');
    });

    it('a saved plugin action shows its binding, offers no test-fire, and converts back to a webhook', async () => {
        const wrapper = await mountOpen(pluginTrigger());
        expect(wrapper.find('[data-test="plugin-action-description"]').text()).toContain('dice / roll');
        await wrapper.find('.more-btn').trigger('click');
        await flushPromises();
        expect(document.querySelector('[data-test="test-fire"]')).toBeNull();

        await choose(wrapper, 'behaviors.action.source', 'behaviors.action.sourceWebhook');
        await wrapper.find('input[inputmode="url"]').setValue('https://hook.example/new');
        await save(wrapper);

        expect(api.updateBehavior).toHaveBeenCalledWith(7, {
            webhook: { url: 'https://hook.example/new', authMode: 'hmac' },
            ifUpdatedAt: '2026-10-27T00:00:00.000Z',
        });
    });

    it('editing a plugin trigger without touching the action leaves the binding out of the PATCH', async () => {
        const wrapper = await mountOpen(pluginTrigger());
        await wrapper.findAll('.editor input')[0].setValue('dice roller');
        await save(wrapper);
        expect(api.updateBehavior).toHaveBeenCalledWith(7, { title: 'dice roller', ifUpdatedAt: '2026-10-27T00:00:00.000Z' });
    });
});

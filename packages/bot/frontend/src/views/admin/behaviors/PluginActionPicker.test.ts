import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import type { PluginBehaviorActions } from '../../../api/behavior';

const api = vi.hoisted(() => ({ getPluginBehaviorActions: vi.fn() }));
vi.mock('../../../api/behavior', () => api);

import PluginActionPicker from './PluginActionPicker.vue';
import { keyI18n, stubMatchMedia } from './behavior-test-support';

const i18n = keyI18n();

const DICE: PluginBehaviorActions = {
    pluginKey: 'dice',
    pluginName: 'Dice',
    enabled: true,
    status: 'active',
    actions: [
        { key: 'roll', name: 'Roll dice', description: 'Rolls the dice in the message' },
        { key: 'flip', name: 'Flip a coin', description: 'Heads or tails' },
    ],
};

const mounted: VueWrapper[] = [];
afterEach(() => mounted.splice(0).forEach((w) => w.unmount()));

async function mountPicker(props: Record<string, unknown> = {}): Promise<VueWrapper> {
    const wrapper = mount(PluginActionPicker, {
        props: { pluginKey: '', actionKey: '', ...props },
        global: { plugins: [i18n] },
        attachTo: document.body,
    });
    mounted.push(wrapper);
    await flushPromises();
    return wrapper;
}

async function openAndPick(wrapper: VueWrapper, option: string) {
    await wrapper.find('button.select-trigger').trigger('click');
    await flushPromises();
    const item = [...document.querySelectorAll<HTMLElement>('li')].find((li) => li.textContent?.trim() === option)!;
    item.click();
    await flushPromises();
}

beforeAll(stubMatchMedia);

beforeEach(() => {
    api.getPluginBehaviorActions.mockReset();
    api.getPluginBehaviorActions.mockResolvedValue([DICE]);
});

describe('PluginActionPicker (#203)', () => {
    it("lists the installed plugins' declared actions and emits the one picked", async () => {
        const wrapper = await mountPicker();
        expect(api.getPluginBehaviorActions).toHaveBeenCalledTimes(1);
        await openAndPick(wrapper, 'Flip a coin');
        expect(wrapper.emitted('pick')).toEqual([[{ pluginKey: 'dice', actionKey: 'flip' }]]);
    });

    it('describes the picked action', async () => {
        const wrapper = await mountPicker({ pluginKey: 'dice', actionKey: 'roll' });
        const description = wrapper.find('[data-test="plugin-action-description"]').text();
        expect(description).toContain('dice / roll');
        expect(description).toContain('Rolls the dice in the message');
        expect(wrapper.find('[data-test="plugin-offline"]').exists()).toBe(false);
        expect(wrapper.find('[data-test="plugin-action-undeclared"]').exists()).toBe(false);
    });

    it('warns when the plugin is disabled or offline', async () => {
        api.getPluginBehaviorActions.mockResolvedValue([{ ...DICE, enabled: false }]);
        const wrapper = await mountPicker({ pluginKey: 'dice', actionKey: 'roll' });
        expect(wrapper.find('[data-test="plugin-offline"]').text()).toBe('behaviors.action.plugin.offline');
    });

    it('keeps a binding the plugin no longer declares on screen, marked', async () => {
        const wrapper = await mountPicker({ pluginKey: 'dice', actionKey: 'explode' });
        expect(wrapper.find('[data-test="plugin-action-undeclared"]').exists()).toBe(true);
        expect(wrapper.find('button.select-trigger').text()).toContain('behaviors.action.plugin.undeclaredOption');
    });

    it('says when no plugin declares an action, and when the list cannot be loaded', async () => {
        api.getPluginBehaviorActions.mockResolvedValue([]);
        expect((await mountPicker()).find('[data-test="plugin-actions-none"]').exists()).toBe(true);
        api.getPluginBehaviorActions.mockRejectedValue(new Error('down'));
        expect((await mountPicker()).find('[data-test="plugin-actions-failed"]').exists()).toBe(true);
    });

    it("shows the server's refusal", async () => {
        const wrapper = await mountPicker({ pluginKey: 'dice', actionKey: 'roll', error: 'not declared' });
        expect(wrapper.text()).toContain('not declared');
    });
});

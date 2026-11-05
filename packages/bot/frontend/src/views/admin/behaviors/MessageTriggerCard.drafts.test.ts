/**
 * #105 — the card keeps the saved trigger and the edit draft apart: a new
 * version from the server never wipes edits in progress, and a stale save
 * is explained instead of retried into the same refusal.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import type { MessageTriggerView } from '../../../api/behavior';
import { ApiError } from '../../../api/client';

const api = vi.hoisted(() => ({
    updateBehavior: vi.fn(),
    deleteBehavior: vi.fn(),
    testBehavior: vi.fn(),
    getBehaviorSchemas: vi.fn(),
    rotateWebhookSecret: vi.fn(),
    getGroupMembers: vi.fn(),
    replaceGroupMembers: vi.fn(),
}));
vi.mock('../../../api/behavior', () => api);
vi.mock('../../../api/guilds', () => ({ listGuilds: vi.fn(async () => []), listGuildTextChannels: vi.fn(async () => []) }));

import MessageTriggerCard from './MessageTriggerCard.vue';
import { MESSAGE_TRIGGER_SCHEMA, keyI18n, savedTrigger, stubMatchMedia } from './behavior-test-support';

const i18n = keyI18n();
const STALE = () => new ApiError(409, 'behavior 7 was changed by someone else', 'validation_failed', 'ifUpdatedAt');

const mounted: VueWrapper[] = [];
afterEach(() => mounted.splice(0).forEach((w) => w.unmount()));

async function mountOpen(t: MessageTriggerView = savedTrigger()): Promise<VueWrapper> {
    const wrapper = mount(MessageTriggerCard, {
        props: { trigger: t, guildNames: new Map(), groupNames: [], groupUse: new Map() },
        global: { plugins: [i18n] },
        attachTo: document.body,
    });
    mounted.push(wrapper);
    await wrapper.find('.app-item-card__expander').trigger('click');
    return wrapper;
}

const titleOf = (wrapper: VueWrapper) => (wrapper.findAll('.editor input')[0].element as HTMLInputElement).value;

async function renameAndSave(wrapper: VueWrapper, title: string) {
    await wrapper.findAll('.editor input')[0].setValue(title);
    await wrapper.find('form.editor').trigger('submit');
    await flushPromises();
}

beforeAll(stubMatchMedia);

beforeEach(() => {
    setActivePinia(createPinia());
    Object.values(api).forEach((fn) => fn.mockReset());
    api.getBehaviorSchemas.mockResolvedValue({ messageTrigger: MESSAGE_TRIGGER_SCHEMA });
    api.getGroupMembers.mockResolvedValue({ groupName: 'ops', members: [] });
});

describe('MessageTriggerCard — saved state vs. draft (#105)', () => {
    it('switching enabled while editing keeps the unsaved edits', async () => {
        api.updateBehavior.mockResolvedValue({ behavior: savedTrigger({ enabled: false, updatedAt: '2026-10-27T01:00:00.000Z' }) });
        const wrapper = await mountOpen();
        await wrapper.findAll('.editor input')[0].setValue('forecast');

        await wrapper.find('[data-test="enabled-toggle"]').trigger('click');
        await flushPromises();
        expect(api.updateBehavior).toHaveBeenCalledWith(7, { enabled: false });
        // the page hands the server's version back down
        const [[toggled]] = wrapper.emitted('updated') as [[MessageTriggerView]];
        await wrapper.setProps({ trigger: toggled });
        expect(titleOf(wrapper)).toBe('forecast');

        api.updateBehavior.mockResolvedValue({ behavior: savedTrigger({ title: 'forecast', enabled: false }) });
        await wrapper.find('form.editor').trigger('submit');
        await flushPromises();
        expect(api.updateBehavior).toHaveBeenLastCalledWith(7, {
            title: 'forecast',
            ifUpdatedAt: '2026-10-27T01:00:00.000Z',
        });
    });
});

describe('MessageTriggerCard — stale saves', () => {
    it('keeps the draft, asks for a reload and blocks saving until the conflict is resolved', async () => {
        api.updateBehavior.mockRejectedValue(STALE());
        const wrapper = await mountOpen();
        await renameAndSave(wrapper, 'forecast');

        expect(wrapper.find('[data-test="conflict"]').exists()).toBe(true);
        expect(wrapper.emitted('reload')).toHaveLength(1);
        expect(titleOf(wrapper)).toBe('forecast');

        // the reload brings someone else's edit: saving now would be refused again
        await wrapper.setProps({ trigger: savedTrigger({ patternValue: '!wx', updatedAt: '2026-10-27T02:00:00.000Z' }) });
        expect(wrapper.find('[data-test="save"]').attributes('disabled')).toBeDefined();
        await wrapper.find('form.editor').trigger('submit');
        await flushPromises();
        expect(api.updateBehavior).toHaveBeenCalledTimes(1);

        // keeping mine applies my edit onto the latest version
        await wrapper.find('[data-test="keep-mine"]').trigger('click');
        expect(wrapper.find('[data-test="save"]').attributes('disabled')).toBeUndefined();
        api.updateBehavior.mockResolvedValue({ behavior: savedTrigger({ title: 'forecast' }) });
        await wrapper.find('form.editor').trigger('submit');
        await flushPromises();
        expect(api.updateBehavior).toHaveBeenLastCalledWith(7, {
            title: 'forecast',
            ifUpdatedAt: '2026-10-27T02:00:00.000Z',
        });
    });

    it('when only unedited state changed, says the save did not happen and that saving again will', async () => {
        api.updateBehavior.mockRejectedValue(STALE());
        const wrapper = await mountOpen();
        await renameAndSave(wrapper, 'forecast');

        // the reload shows only that someone switched it off
        await wrapper.setProps({ trigger: savedTrigger({ enabled: false, updatedAt: '2026-10-27T02:00:00.000Z' }) });
        expect(wrapper.find('[data-test="conflict"]').exists()).toBe(false);
        expect(wrapper.find('[data-test="stale"]').exists()).toBe(true);
        expect(titleOf(wrapper)).toBe('forecast');
        expect(wrapper.find('[data-test="save"]').attributes('disabled')).toBeUndefined();
    });
});

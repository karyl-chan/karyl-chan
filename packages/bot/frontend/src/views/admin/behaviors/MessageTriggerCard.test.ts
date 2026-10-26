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
const confirmMock = vi.hoisted(() => vi.fn());
vi.mock('../../../api/behavior', () => api);
vi.mock('../../../api/discord', () => ({ fetchUserSummaries: vi.fn(async () => []) }));
vi.mock('../../../api/guilds', () => ({ listGuilds: vi.fn(async () => []), listGuildTextChannels: vi.fn(async () => []) }));
vi.mock('@karyl-chan/ui', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@karyl-chan/ui')>()),
    useConfirm: () => ({ confirm: confirmMock }),
}));

import MessageTriggerCard from './MessageTriggerCard.vue';
import { MESSAGE_TRIGGER_SCHEMA, keyI18n, savedTrigger, stubMatchMedia } from './behavior-test-support';

const i18n = keyI18n();
const GUILD = '123456789012345678';

const mounted: VueWrapper[] = [];
afterEach(() => mounted.splice(0).forEach((w) => w.unmount()));

async function mountOpen(
    t: MessageTriggerView = savedTrigger(),
    groupUse: Map<string, number> = new Map(),
): Promise<VueWrapper> {
    const wrapper = mount(MessageTriggerCard, {
        props: { trigger: t, guildNames: new Map(), groupNames: [...groupUse.keys()], groupUse },
        global: { plugins: [i18n] },
        attachTo: document.body,
    });
    mounted.push(wrapper);
    await wrapper.find('.app-item-card__expander').trigger('click');
    await flushPromises();
    return wrapper;
}

async function rename(wrapper: VueWrapper, title: string) {
    await wrapper.findAll('.editor input')[0].setValue(title);
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

beforeAll(stubMatchMedia);

beforeEach(() => {
    setActivePinia(createPinia());
    Object.values(api).forEach((fn) => fn.mockReset());
    confirmMock.mockReset();
    api.getBehaviorSchemas.mockResolvedValue({ messageTrigger: MESSAGE_TRIGGER_SCHEMA });
    api.getGroupMembers.mockResolvedValue({ groupName: 'ops', members: [] });
});

describe('MessageTriggerCard — editing', () => {
    it('cancel puts the saved values back', async () => {
        const wrapper = await mountOpen();
        await rename(wrapper, 'forecast');
        const cancel = wrapper.findAll('footer button').find((b) => b.text() === 'common.cancel')!;
        await cancel.trigger('click');
        expect((wrapper.findAll('.editor input')[0].element as HTMLInputElement).value).toBe('weather');
    });

    it('moving out of bot DMs says where it goes and that replies become public (board 7)', async () => {
        const wrapper = await mountOpen();
        await choose(wrapper, 'behaviors.location.label', 'behaviors.location.guild_all');
        const moved = wrapper.find('[data-test="moved"]');
        expect(moved.text()).toContain('behaviors.trigger.moved');
        expect(moved.text()).toContain('behaviors.trigger.movedPublic');
    });

    it('moving between server locations does not warn about replies going public', async () => {
        const wrapper = await mountOpen(savedTrigger({ surface: 'guild', section: 'guild:all' }));
        await choose(wrapper, 'behaviors.location.label', 'behaviors.location.guild');
        // no guild yet: nowhere to move to
        expect(wrapper.find('[data-test="moved"]').exists()).toBe(false);
        const guild = wrapper.findAll('.app-field').find((f) => f.text().includes('behaviors.location.guildPicker'))!;
        await guild.find('input').setValue(GUILD);
        expect(wrapper.find('[data-test="moved"]').text()).not.toContain('behaviors.trigger.movedPublic');
    });
});

describe('MessageTriggerCard — errors', () => {
    it('refuses a draft the server schema refuses, on its field, without sending it', async () => {
        const wrapper = await mountOpen();
        await rename(wrapper, '   ');
        await wrapper.find('form.editor').trigger('submit');
        await flushPromises();
        expect(api.updateBehavior).not.toHaveBeenCalled();
        expect(wrapper.find('.app-field__error').text()).toBe('behaviors.validation.required');
    });

    it('puts a server refusal that names a field onto that field', async () => {
        api.updateBehavior.mockRejectedValue(
            new ApiError(400, 'http://x is refused (https_required)', 'validation_failed', 'webhook.url')
        );
        const wrapper = await mountOpen();
        await rename(wrapper, 'forecast');
        await wrapper.find('form.editor').trigger('submit');
        await flushPromises();
        const urlField = wrapper.findAll('.app-field').find((f) => f.text().includes('behaviors.action.url'))!;
        expect(urlField.find('.app-field__error').text()).toContain('https_required');
        expect(wrapper.find('[data-test="general-error"]').exists()).toBe(false);
    });

    it('a refusal on a field without an error line is shown, not swallowed', async () => {
        api.updateBehavior.mockRejectedValue(
            new ApiError(400, 'ignoreBots only applies in guilds', 'validation_failed', 'ignoreBots')
        );
        const wrapper = await mountOpen();
        await rename(wrapper, 'forecast');
        await wrapper.find('form.editor').trigger('submit');
        await flushPromises();
        expect(wrapper.find('[data-test="general-error"]').text()).toContain('behaviors.errors.withDetail');
    });
});

describe('MessageTriggerCard — the sole user of a group', () => {
    const ops = savedTrigger({ audienceKind: 'group', audienceGroupName: 'ops' });

    beforeEach(() => {
        api.getGroupMembers.mockResolvedValue({ groupName: 'ops', members: ['1', '2', '3'] });
    });

    it('warns that leaving the group drops its member list', async () => {
        const wrapper = await mountOpen(ops, new Map([['ops', 1]]));
        expect(wrapper.find('[data-test="group-drop"]').exists()).toBe(false);
        await choose(wrapper, 'behaviors.audience.label', 'behaviors.audience.all');
        expect(wrapper.find('[data-test="group-drop"]').text()).toContain('behaviors.group.dropOnSave');
    });

    it('does not warn when another trigger still uses the group', async () => {
        const wrapper = await mountOpen(ops, new Map([['ops', 2]]));
        await choose(wrapper, 'behaviors.audience.label', 'behaviors.audience.all');
        expect(wrapper.find('[data-test="group-drop"]').exists()).toBe(false);
    });

    it('the delete confirmation says the member list goes too', async () => {
        confirmMock.mockResolvedValue(false);
        const wrapper = await mountOpen(ops, new Map([['ops', 1]]));
        await wrapper.find('.more-btn').trigger('click');
        await flushPromises();
        document.querySelector<HTMLElement>('[data-test="delete"]')!.click();
        await flushPromises();
        expect(confirmMock.mock.calls[0][0].message).toContain('behaviors.group.dropOnDelete');
        expect(api.deleteBehavior).not.toHaveBeenCalled();
    });
});

describe('MessageTriggerCard — header actions', () => {
    it('test-fires the webhook and shows the reply', async () => {
        api.testBehavior.mockResolvedValue({ ok: true, relayContent: 'sunny', relayEmbeds: [], error: null, errorCode: null });
        const wrapper = await mountOpen();
        await wrapper.find('.more-btn').trigger('click');
        await flushPromises();
        // the menu is teleported to <body>
        document.querySelector<HTMLElement>('[data-test="test-fire"]')!.click();
        await flushPromises();
        expect(api.testBehavior).toHaveBeenCalledWith(7);
        expect(wrapper.find('[data-test="test-result"]').text()).toContain('sunny');
    });
});

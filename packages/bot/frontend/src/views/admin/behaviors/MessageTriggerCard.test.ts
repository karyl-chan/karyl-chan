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

describe('MessageTriggerCard — who sees the reply (#140)', () => {
    it('a guild trigger saves a private default; picking the default again stores null', async () => {
        const saved = savedTrigger({ surface: 'guild', section: 'guild:all', ignoreBots: true });
        api.updateBehavior.mockImplementation(async (_id: number, patch: Record<string, unknown>) => ({
            behavior: { ...saved, ...patch },
        }));
        const wrapper = await mountOpen(saved);
        await choose(wrapper, 'behaviors.action.replyVisibility.label', 'behaviors.action.replyVisibility.guild.private');
        await wrapper.find('form.editor').trigger('submit');
        await flushPromises();
        expect(api.updateBehavior).toHaveBeenLastCalledWith(7, expect.objectContaining({ replyVisibility: 'private' }));

        await choose(
            wrapper,
            'behaviors.action.replyVisibility.label',
            'behaviors.action.replyVisibility.guild.publicbehaviors.action.replyVisibility.defaultMark'
        );
        await wrapper.find('form.editor').trigger('submit');
        await flushPromises();
        expect(api.updateBehavior).toHaveBeenLastCalledWith(7, expect.objectContaining({ replyVisibility: null }));
    });

    it('is not a choice in a DM with the bot', async () => {
        const wrapper = await mountOpen();
        expect(wrapper.find('[data-test="reply-visibility"]').exists()).toBe(false);
        expect(wrapper.find('[data-test="reply-visibility-na"]').exists()).toBe(true);
    });

    it('the test preview applies the stored default when the response does not say', async () => {
        api.testBehavior.mockResolvedValue({
            ok: true,
            reply: { content: 'x' },
            notes: [],
            status: null,
            error: null,
            errorCode: null,
            verified: null,
        });
        const wrapper = await mountOpen(savedTrigger({ surface: 'guild', section: 'guild:all', replyVisibility: 'private' }));
        await wrapper.find('.more-btn').trigger('click');
        await flushPromises();
        document.querySelector<HTMLElement>('[data-test="test-fire"]')!.click();
        await flushPromises();
        expect(wrapper.find('[data-test="preview-audience"]').text()).toBe('behaviors.testReply.audience.author_dm');
    });
});

describe('MessageTriggerCard — try it', () => {
    it('shows the groups a regex captures, as the service will receive them', async () => {
        const wrapper = await mountOpen(savedTrigger({ patternKind: 'regex', patternValue: '^天氣\\s+(.+)' }));
        await wrapper.find('input[placeholder="behaviors.trigger.tryPlaceholder"]').setValue('天氣 台北');
        expect(wrapper.find('[data-test="try-result"]').text()).toBe('behaviors.trigger.preview.matchWithGroups');
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
    async function testFire(wrapper: VueWrapper): Promise<void> {
        await wrapper.find('.more-btn').trigger('click');
        await flushPromises();
        // the menu is teleported to <body>
        document.querySelector<HTMLElement>('[data-test="test-fire"]')!.click();
        await flushPromises();
    }

    it('test-fires the webhook and previews the reply as the bot would render it', async () => {
        api.testBehavior.mockResolvedValue({
            ok: true,
            reply: {
                content: 'sunny',
                embeds: [{ title: 'Forecast' }],
                components: [{ type: 1, components: [{ type: 2, style: 5, label: 'More', url: 'https://w.example' }] }],
                ephemeral: true,
            },
            notes: [{ kind: 'unknown_fields', fields: ['tts'] }],
            status: null,
            error: null,
            errorCode: null,
            verified: 'hmac',
        });
        const wrapper = await mountOpen(savedTrigger({ surface: 'guild', section: 'guild:all' }));
        await testFire(wrapper);
        expect(api.testBehavior).toHaveBeenCalledWith(7);
        const result = wrapper.find('[data-test="test-result"]');
        expect(result.text()).toContain('sunny');
        expect(result.find('[data-test="preview-embeds"]').exists()).toBe(true);
        expect(result.findAll('[data-test="preview-button"]')).toHaveLength(1);
        // a guild trigger's ephemeral reply goes to the author's DMs
        expect(result.find('[data-test="preview-audience"]').text()).toBe('behaviors.testReply.audience.author_dm');
        expect(result.find('[data-test="preview-notes"]').text()).toContain('behaviors.testReply.note.unknown_fields');
        expect(result.find('[data-test="preview-verified"]').text()).toBe('behaviors.testReply.verified.hmac');
    });

    it('explains a response whose signature does not verify, by its code', async () => {
        api.testBehavior.mockResolvedValue({
            ok: false,
            reply: {},
            notes: [],
            status: 200,
            error: 'response nonce does not match the request',
            errorCode: 'response_signature',
            verified: null,
        });
        const wrapper = await mountOpen();
        await testFire(wrapper);
        expect(wrapper.find('[data-test="test-hint"]').text()).toBe('behaviors.testReply.signatureHint');
    });

    it('explains a receiver that refuses the test signature', async () => {
        api.testBehavior.mockResolvedValue({
            ok: false,
            reply: {},
            notes: [],
            status: 401,
            error: 'unauthorized',
            errorCode: null,
            verified: null,
        });
        const wrapper = await mountOpen();
        await testFire(wrapper);
        expect(wrapper.find('[data-test="test-hint"]').text()).toBe('behaviors.testReply.refusedHint');
    });
});

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { computed } from 'vue';
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
    getBehaviorDmAllowlist: vi.fn(),
    replaceBehaviorDmAllowlist: vi.fn(),
    getBehaviorDmLog: vi.fn(),
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
import {
    BUILTIN_TARGETS,
    MESSAGE_TRIGGER_SCHEMA,
    createdTarget,
    keyI18n,
    savedTrigger,
    stubMatchMedia,
} from './behavior-test-support';
import { TARGET_DIRECTORY, type TargetDirectory } from './target-directory';
import { NO_NAMES } from './target-labels';

const i18n = keyI18n();
const GUILD = '123456789012345678';

const mounted: VueWrapper[] = [];
afterEach(() => mounted.splice(0).forEach((w) => w.unmount()));

/** The targets the card's target select offers — what the page provides. */
const directory: TargetDirectory = {
    targets: computed(() => [...BUILTIN_TARGETS, createdTarget(`guild:${GUILD}`), createdTarget('group:ops')]),
    names: computed(() => NO_NAMES),
    created: () => undefined,
};

async function mountOpen(t: MessageTriggerView = savedTrigger()): Promise<VueWrapper> {
    const wrapper = mount(MessageTriggerCard, {
        props: { trigger: t, guildNames: new Map(), commands: [] },
        global: { plugins: [i18n], provide: { [TARGET_DIRECTORY as symbol]: directory } },
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

    it('offers the targets the sidebar lists, never App 指令, and "new target"', async () => {
        const wrapper = await mountOpen();
        const field = wrapper.findAll('label.field').find((f) => f.find('.field-label').text() === 'behaviors.targetField.label')!;
        await field.find('button.select-trigger').trigger('click');
        await flushPromises();
        // every select's options are on the page; the open one's come last
        const options = [...document.querySelectorAll<HTMLElement>('li')].map((li) => li.textContent?.trim());
        expect(options.slice(-5)).toEqual([
            'behaviors.target.botDm',
            'behaviors.target.guildAll',
            GUILD,
            'ops',
            'behaviors.targetField.new',
        ]);
        expect(options).not.toContain('behaviors.target.app');
    });

    it('choosing a target is the whole of where and for whom: a group is a bot DM trigger for it', async () => {
        api.updateBehavior.mockResolvedValue({ behavior: savedTrigger({ audienceKind: 'group', audienceGroupName: 'ops' }) });
        const wrapper = await mountOpen();
        await choose(wrapper, 'behaviors.targetField.label', 'ops');
        await wrapper.find('form.editor').trigger('submit');
        await flushPromises();
        expect(api.updateBehavior).toHaveBeenCalledWith(7, {
            audienceKind: 'group',
            audienceGroupName: 'ops',
            ifUpdatedAt: '2026-10-27T00:00:00.000Z',
        });
    });

    it('moving out of bot DMs says where it goes and that replies become public (board 7)', async () => {
        const wrapper = await mountOpen();
        await choose(wrapper, 'behaviors.targetField.label', 'behaviors.target.guildAll');
        const moved = wrapper.find('[data-test="moved"]');
        expect(moved.text()).toContain('behaviors.trigger.moved');
        expect(moved.text()).toContain('behaviors.trigger.movedPublic');
    });

    it('moving between server targets does not warn about replies going public', async () => {
        const wrapper = await mountOpen(savedTrigger({ surface: 'guild', target: 'guild:all', section: 'guild:all' }));
        expect(wrapper.find('[data-test="moved"]').exists()).toBe(false);
        await choose(wrapper, 'behaviors.targetField.label', GUILD);
        expect(wrapper.find('[data-test="moved"]').text()).toContain('behaviors.trigger.moved');
        expect(wrapper.find('[data-test="moved"]').text()).not.toContain('behaviors.trigger.movedPublic');
    });

    it('moving within bot DMs — to a group — is a move, but replies stay private', async () => {
        const wrapper = await mountOpen();
        await choose(wrapper, 'behaviors.targetField.label', 'ops');
        expect(wrapper.find('[data-test="moved"]').text()).not.toContain('behaviors.trigger.movedPublic');
    });

    it('a problem with where or for whom shows on the target select', async () => {
        api.updateBehavior.mockRejectedValue(
            new ApiError(400, 'guildId must be a Discord id', 'validation_failed', 'guildId')
        );
        const wrapper = await mountOpen();
        await choose(wrapper, 'behaviors.targetField.label', GUILD);
        await wrapper.find('form.editor').trigger('submit');
        await flushPromises();
        expect(wrapper.find('[data-test="target-error"]').text()).toContain('guildId must be a Discord id');
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

    it('a regex the browser runs but the bot refuses (#119) shows the reason on the pattern', async () => {
        api.updateBehavior.mockRejectedValue(
            new ApiError(400, 'the regex uses a feature that cannot run in linear time', 'validation_failed', 'patternValue')
        );
        const wrapper = await mountOpen(savedTrigger({ patternKind: 'regex', patternValue: '^(\\w)\\1' }));
        await rename(wrapper, 'forecast');
        await wrapper.find('form.editor').trigger('submit');
        await flushPromises();
        const patternField = wrapper.findAll('.app-field').find((f) => f.text().includes('behaviors.trigger.patternValue'))!;
        expect(patternField.find('.app-field__error').text()).toContain('linear time');
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

describe('MessageTriggerCard — who replies may DM (#157)', () => {
    const USER = '222222222222222222';

    async function addDmUser(wrapper: VueWrapper) {
        api.getBehaviorDmAllowlist.mockResolvedValue({ userIds: [], groupNames: [] });
        api.getBehaviorDmLog.mockResolvedValue({ entries: [] });
        await wrapper.get('[data-test="dm-toggle"]').trigger('click');
        await flushPromises();
        await wrapper.get('[data-test="dm-user-input"] input').setValue(USER);
        await wrapper.get('[data-test="dm-add-user"]').trigger('click');
        await flushPromises();
    }

    it('a change to the list waits for the card’s save, and is all it sends', async () => {
        api.replaceBehaviorDmAllowlist.mockResolvedValue({ userIds: [USER], groupNames: [] });
        const wrapper = await mountOpen();
        expect(wrapper.get('[data-test="save"]').attributes('disabled')).toBeDefined();

        await addDmUser(wrapper);
        expect(api.replaceBehaviorDmAllowlist).not.toHaveBeenCalled();
        expect(wrapper.get('[data-test="save"]').attributes('disabled')).toBeUndefined();

        await wrapper.get('form.editor').trigger('submit');
        await flushPromises();

        expect(api.replaceBehaviorDmAllowlist).toHaveBeenCalledWith(savedTrigger().id, { userIds: [USER], groupNames: [] });
        expect(api.updateBehavior).not.toHaveBeenCalled();
        expect(wrapper.get('[data-test="save"]').attributes('disabled')).toBeDefined();
        expect(wrapper.findAll('[data-test="dm-user"]')).toHaveLength(1);
    });

    it('the card’s cancel drops the change', async () => {
        const wrapper = await mountOpen();
        await addDmUser(wrapper);

        await wrapper.findAll('.footer button')[0].trigger('click');
        await flushPromises();

        expect(wrapper.find('[data-test="dm-user"]').exists()).toBe(false);
        expect(api.replaceBehaviorDmAllowlist).not.toHaveBeenCalled();
        expect(wrapper.get('[data-test="save"]').attributes('disabled')).toBeDefined();
    });
});

/**
 * #172 — a message trigger converts to a command leaf from its kind tag:
 * the tag's menu offers the other kind, the dialog fills the target (a new
 * command, or a subcommand of a command that has subcommands) and lists
 * what the trigger loses before anything is sent.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import type { CommandView, MessageTriggerView } from '../../../api/behavior';
import { ApiError } from '../../../api/client';

const api = vi.hoisted(() => ({
    convertToCommand: vi.fn(),
    updateBehavior: vi.fn(),
    deleteBehavior: vi.fn(),
    testBehavior: vi.fn(),
    getBehaviorSchemas: vi.fn(),
    getBehaviorDeliveries: vi.fn(),
    rotateWebhookSecret: vi.fn(),
    getGroupMembers: vi.fn(),
    replaceGroupMembers: vi.fn(),
}));
vi.mock('../../../api/behavior', () => api);
vi.mock('../../../api/discord', () => ({ fetchUserSummaries: vi.fn(async () => []) }));
vi.mock('../../../api/guilds', () => ({ listGuilds: vi.fn(async () => []), listGuildTextChannels: vi.fn(async () => []) }));

import MessageTriggerCard from './MessageTriggerCard.vue';
import {
    COMMAND_SCHEMA,
    CONVERT_TRIGGER_SCHEMA,
    keyI18n,
    savedCommand,
    savedLeaf,
    savedTrigger,
    stubMatchMedia,
} from './behavior-test-support';

const i18n = keyI18n();
const GUILD = '123456789012345678';
const CHANNEL = '223456789012345678';

const mounted: VueWrapper[] = [];
afterEach(() => mounted.splice(0).forEach((w) => w.unmount()));

beforeAll(stubMatchMedia);

beforeEach(() => {
    setActivePinia(createPinia());
    Object.values(api).forEach((fn) => fn.mockReset());
    api.getBehaviorSchemas.mockResolvedValue({ command: COMMAND_SCHEMA, convertTrigger: CONVERT_TRIGGER_SCHEMA });
    api.getBehaviorDeliveries.mockResolvedValue({ deliveries: [] });
});

/** The dialog and the menu are teleported to <body>. */
const $ = (selector: string) => document.body.querySelector<HTMLElement>(selector);
const submit = () => $('[data-test="convert-submit"]') as HTMLButtonElement;

async function openConvert(
    trigger: MessageTriggerView = savedTrigger(),
    commands: CommandView[] = [],
): Promise<VueWrapper> {
    const wrapper = mount(MessageTriggerCard, {
        props: { trigger, guildNames: new Map(), groupNames: [], groupUse: new Map(), commands },
        global: { plugins: [i18n] },
        attachTo: document.body,
    });
    mounted.push(wrapper);
    await wrapper.find('[data-test="trigger-kind"]').trigger('click');
    await flushPromises();
    $('[data-test="convert-to-command"]')!.click();
    await flushPromises();
    return wrapper;
}

async function type(selector: string, value: string) {
    const input = $(`${selector} input`) as HTMLInputElement;
    input.value = value;
    input.dispatchEvent(new Event('input'));
    await flushPromises();
}

const losses = () => [...document.querySelectorAll<HTMLElement>('[data-test="convert-losses"] li')].map((li) => li.dataset.loss);

describe('the kind tag', () => {
    it('offers the other kind only, and opens the dialog without sending anything', async () => {
        const wrapper = mount(MessageTriggerCard, {
            props: { trigger: savedTrigger(), guildNames: new Map(), groupNames: [], groupUse: new Map(), commands: [] },
            global: { plugins: [i18n] },
            attachTo: document.body,
        });
        mounted.push(wrapper);
        expect(wrapper.find('[data-test="trigger-kind"]').text()).toContain('behaviors.card.triggerMessage');
        await wrapper.find('[data-test="trigger-kind"]').trigger('click');
        await flushPromises();
        expect($('[data-test="convert-to-message"]')!.hasAttribute('disabled')).toBe(true);
        $('[data-test="convert-to-command"]')!.click();
        await flushPromises();
        expect($('[data-test="convert-command-dialog"]')).not.toBeNull();
        expect(api.convertToCommand).not.toHaveBeenCalled();
    });
});

describe('message → a new command', () => {
    it('starts from the title and the section, lists the losses, and converts', async () => {
        const command = savedCommand({ name: 'weather', leaves: [savedLeaf({ id: 7, title: 'weather' })] });
        api.convertToCommand.mockResolvedValue({
            behavior: command.leaves[0],
            command,
            registration: { status: 'registered', targets: [{ target: 'global', status: 'created' }] },
        });
        const wrapper = await openConvert();
        expect(($('[data-test="convert-command-name"] input') as HTMLInputElement).value).toBe('weather');
        expect($('[data-test="convert-path"]')!.textContent).toContain('/weather');
        expect(losses()).toEqual(['pattern', 'payloadToCommand']);

        submit().click();
        await flushPromises();
        expect(api.convertToCommand).toHaveBeenCalledWith(7, {
            command: {
                new: {
                    name: 'weather',
                    description: 'weather',
                    registration: 'global',
                    guildId: null,
                    // a bot DM trigger: a command usable in DMs with the bot
                    integrationTypes: ['guild_install'],
                    contexts: ['BotDM'],
                },
            },
            ifUpdatedAt: '2026-10-27T00:00:00.000Z',
        });
        expect(wrapper.emitted('converted')).toEqual([[command]]);
    });

    it('says what a channel trigger, an audience and a public reply lose', async () => {
        await openConvert(
            savedTrigger({ surface: 'guild', guildId: GUILD, channelId: CHANNEL, section: `channel:${GUILD}:${CHANNEL}` })
        );
        expect(losses()).toEqual(['channel', 'pattern', 'replyPrivate', 'payloadToCommand']);
        mounted.splice(0).forEach((w) => w.unmount());

        await openConvert(savedTrigger({ audienceKind: 'user', audienceUserId: GUILD }));
        expect(losses()).toEqual(['audience', 'pattern', 'payloadToCommand']);
    });

    it("a channel's trigger becomes a command of the channel's server", async () => {
        api.convertToCommand.mockResolvedValue({ behavior: savedLeaf(), command: savedCommand(), registration: { status: 'removed' } });
        await openConvert(
            savedTrigger({ surface: 'guild', guildId: GUILD, channelId: CHANNEL, section: `channel:${GUILD}:${CHANNEL}` })
        );
        submit().click();
        await flushPromises();
        expect(api.convertToCommand.mock.calls[0][1].command.new).toMatchObject({
            registration: 'guild',
            guildId: GUILD,
            contexts: ['Guild'],
            integrationTypes: ['guild_install'],
        });
    });

    it('a title with nothing usable leaves the name to the admin, without an error before they act', async () => {
        await openConvert(savedTrigger({ title: '天氣查詢' }));
        const field = $('[data-test="convert-command-name"]')!;
        expect((field.querySelector('input') as HTMLInputElement).value).toBe('');
        // no "format" error the moment the dialog opens; the hint says what a name may hold
        expect(field.textContent).not.toContain('behaviors.validation');
        expect(field.textContent).toContain('behaviors.convertTrigger.toCommand.nameFromTitleEmpty');
        expect(submit().disabled).toBe(false);

        submit().click();
        await flushPromises();
        expect(api.convertToCommand).not.toHaveBeenCalled();
        expect(field.textContent).toContain('behaviors.validation.required');
        expect(field.textContent).not.toContain('behaviors.validation.format');
        expect(submit().disabled).toBe(true);

        await type('[data-test="convert-command-name"]', 'tenki');
        expect(submit().disabled).toBe(false);
    });

    it('Discord refuses: the dialog says so and nothing moves', async () => {
        api.convertToCommand.mockRejectedValue(
            new ApiError(502, 'Discord did not accept /weather: Missing Access', 'registration_failed', null, {
                targets: [{ target: 'global', status: 'failed', attempted: 'create', error: 'Missing Access' }],
            })
        );
        const wrapper = await openConvert();
        submit().click();
        await flushPromises();
        const result = $('[data-test="convert-command-dialog"] [data-test="registration-result"]')!;
        expect(result.getAttribute('data-tone')).toBe('danger');
        expect(result.textContent).toContain('Missing Access');
        expect(wrapper.emitted('converted')).toBeUndefined();
    });

    it('a name the server refuses shows on the name field', async () => {
        api.convertToCommand.mockRejectedValue(
            new ApiError(409, '/weather is already taken by a command of plugin #7', 'name_conflict', 'command.new.name')
        );
        await openConvert();
        submit().click();
        await flushPromises();
        expect($('[data-test="convert-command-name"]')!.textContent).toContain('already taken');
    });
});

describe('message → a subcommand of an existing command', () => {
    const tree = savedCommand({
        id: 5,
        name: 'nas',
        leaves: [savedLeaf({ id: 30, subcommand: 'wake' })],
    });
    const single = savedCommand({ id: 6, name: 'solo' });

    it('lists only commands with subcommands, says why the others are not, and converts', async () => {
        api.convertToCommand.mockResolvedValue({ behavior: savedLeaf(), command: tree, registration: { status: 'removed' } });
        await openConvert(savedTrigger(), [tree, single]);
        $('[data-test="target-existing"]')!.click();
        await flushPromises();
        expect($('[data-test="existing-note"]')!.textContent).toContain('behaviors.convertTrigger.toCommand.singleNote');
        expect($('[data-test="convert-path"]')!.textContent).toContain('/nas weather');

        submit().click();
        await flushPromises();
        expect(api.convertToCommand).toHaveBeenCalledWith(7, {
            command: { existingId: 5, subcommandName: 'weather' },
            ifUpdatedAt: '2026-10-27T00:00:00.000Z',
        });
    });

    it('is not offered when no command has subcommands', async () => {
        await openConvert(savedTrigger(), [single]);
        expect(($('[data-test="target-existing"]') as HTMLButtonElement).disabled).toBe(true);
        expect($('[data-test="existing-note"]')!.textContent).toContain('behaviors.convertTrigger.toCommand.noExisting');
    });

    it('checks the subcommand name against the served schema', async () => {
        await openConvert(savedTrigger(), [tree]);
        $('[data-test="target-existing"]')!.click();
        await flushPromises();
        await type('[data-test="convert-subcommand"]', 'Bad Name');
        expect(submit().disabled).toBe(true);
        expect($('[data-test="convert-subcommand"]')!.textContent).toContain('behaviors.validation.format');
    });
});

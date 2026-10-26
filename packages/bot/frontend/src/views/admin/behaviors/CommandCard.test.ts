import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import type { CommandView } from '../../../api/behavior';
import { ApiError } from '../../../api/client';

const api = vi.hoisted(() => ({
    resyncBehaviorCommand: vi.fn(),
    updateBehaviorCommand: vi.fn(),
    getBehaviorSchemas: vi.fn(),
}));
const confirmMock = vi.hoisted(() => vi.fn());
vi.mock('../../../api/behavior', () => api);
vi.mock('../../../api/guilds', () => ({ listGuilds: vi.fn(async () => []), listGuildTextChannels: vi.fn(async () => []) }));
vi.mock('@karyl-chan/ui', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@karyl-chan/ui')>()),
    useConfirm: () => ({ confirm: confirmMock }),
}));

import { defineComponent, h, ref as vueRef } from 'vue';
import CommandCard from './CommandCard.vue';
import { provideRegistrationResults } from './use-registration-results';
import { COMMAND_SCHEMA, keyI18n, savedCommand, savedLeaf, stubMatchMedia } from './behavior-test-support';

const i18n = keyI18n();
const GUILD = '123456789012345678';

const mounted: VueWrapper[] = [];
afterEach(() => mounted.splice(0).forEach((w) => w.unmount()));

function mountCard(command: CommandView = savedCommand()): VueWrapper {
    const wrapper = mount(CommandCard, {
        props: { command, guildNames: new Map([[GUILD, 'tutor']]) },
        global: { plugins: [i18n] },
        attachTo: document.body,
    });
    mounted.push(wrapper);
    return wrapper;
}

/** Pick an item of the card's ⋮ menu (teleported to <body>). */
async function menu(wrapper: VueWrapper, item: string) {
    await wrapper.find('.more-btn').trigger('click');
    await flushPromises();
    document.querySelector<HTMLElement>(`[data-test="${item}"]`)!.click();
    await flushPromises();
}

beforeAll(stubMatchMedia);

beforeEach(() => {
    setActivePinia(createPinia());
    Object.values(api).forEach((fn) => fn.mockReset());
    confirmMock.mockReset();
    api.getBehaviorSchemas.mockResolvedValue({ command: COMMAND_SCHEMA });
});

describe('CommandCard — resync (#107)', () => {
    it('a refused resync shows the real error and each target, never success', async () => {
        api.resyncBehaviorCommand.mockRejectedValue(
            new ApiError(502, 'Discord did not accept /status: Missing Access', 'registration_failed', null, {
                targets: [{ target: 'global', status: 'failed', attempted: 'patch', error: 'Missing Access' }],
            })
        );
        const wrapper = mountCard();
        await menu(wrapper, 'resync');
        expect(api.resyncBehaviorCommand).toHaveBeenCalledWith(4);
        const result = wrapper.find('[data-test="registration-result"]');
        expect(result.attributes('data-tone')).toBe('danger');
        expect(result.text()).toContain('behaviors.registration.failed');
        expect(result.text()).toContain('Missing Access');
        expect(result.text()).not.toContain('behaviors.registration.registered');
        expect(wrapper.emitted('updated')).toBeUndefined();
    });

    it('a resync that went through says so per target and passes the command on', async () => {
        const command = savedCommand({ updatedAt: '2026-10-27T01:00:00.000Z' });
        api.resyncBehaviorCommand.mockResolvedValue({
            command,
            registration: { status: 'registered', targets: [{ target: 'global', status: 'created' }] },
        });
        const wrapper = mountCard();
        await menu(wrapper, 'resync');
        const result = wrapper.find('[data-test="registration-result"]');
        expect(result.attributes('data-tone')).toBe('ok');
        expect(result.text()).toContain('behaviors.registration.outcome.created');
        expect(wrapper.emitted('updated')).toEqual([[command]]);
    });

    it('a deferred resync is a warning, not a success', async () => {
        api.resyncBehaviorCommand.mockResolvedValue({
            command: savedCommand(),
            registration: { status: 'deferred', reason: 'the bot is not connected to Discord' },
        });
        const wrapper = mountCard();
        await menu(wrapper, 'resync');
        const result = wrapper.find('[data-test="registration-result"]');
        expect(result.attributes('data-tone')).toBe('warn');
        expect(result.text()).toContain('the bot is not connected to Discord');
    });
});

async function mountOpen(command: CommandView = savedCommand()): Promise<VueWrapper> {
    const wrapper = mountCard(command);
    await wrapper.find('.app-item-card__expander').trigger('click');
    await flushPromises();
    return wrapper;
}

/** The command form (not a leaf's). */
const commandForm = (wrapper: VueWrapper) => wrapper.find('form[data-test="command-form"]');

async function setText(wrapper: VueWrapper, label: string, value: string) {
    const field = commandForm(wrapper).findAll('.app-field').find((f) => f.find('.app-field__label').text() === label)!;
    await field.find('input').setValue(value);
}

async function tick(wrapper: VueWrapper, group: 'contexts' | 'integration-types', label: string) {
    const box = wrapper
        .find(`[data-test="${group}"]`)
        .findAll('label')
        .find((l) => l.text() === label)!;
    await box.find('input').setValue(!(box.find('input').element as HTMLInputElement).checked);
}

async function save(wrapper: VueWrapper) {
    await commandForm(wrapper).trigger('submit');
    await flushPromises();
}

describe('CommandCard — name and visibility (board 5)', () => {
    it('says which section the command lands in while editing', async () => {
        const wrapper = await mountOpen();
        expect(wrapper.find('[data-test="section-hint"]').text()).toContain('behaviors.command.sectionHere');
        await tick(wrapper, 'integration-types', 'behaviors.card.integration.user_install');
        expect(wrapper.find('[data-test="section-hint"]').text()).toContain('behaviors.command.sectionMoves');
    });

    it("shows Discord's rule on the field it concerns and does not save", async () => {
        const wrapper = await mountOpen();
        await tick(wrapper, 'contexts', 'behaviors.card.context.PrivateChannel');
        expect(wrapper.find('[data-test="contexts"]').text()).toContain('behaviors.command.rule.privateChannelNeedsUserInstall');
        await save(wrapper);
        expect(api.updateBehaviorCommand).not.toHaveBeenCalled();
    });

    it('a description Discord would refuse is flagged while typing, and saving waits', async () => {
        const wrapper = await mountOpen();
        await setText(wrapper, 'behaviors.command.description', 'x'.repeat(101));
        await flushPromises();
        const field = commandForm(wrapper).findAll('.app-field').find((f) => f.text().includes('behaviors.command.description'))!;
        expect(field.find('.app-field__error').text()).toBe('behaviors.validation.tooLong');
        expect(wrapper.find('[data-test="save-command"]').attributes('disabled')).toBeDefined();
    });

    it('a server command fixes contexts and installs', async () => {
        const guild = savedCommand({ registration: 'guild', guildId: GUILD, contexts: ['Guild'], section: `guild:${GUILD}` });
        const wrapper = await mountOpen(guild);
        expect(wrapper.find('[data-test="contexts"]').attributes('disabled')).toBeDefined();
        expect(wrapper.find('[data-test="integration-types"]').attributes('disabled')).toBeDefined();
    });

    it('saves only what changed, based on the version it started from, and reports the registration', async () => {
        const saved = savedCommand({ description: 'Uptime', updatedAt: '2026-10-27T02:00:00.000Z' });
        api.updateBehaviorCommand.mockResolvedValue({
            command: saved,
            registration: { status: 'registered', targets: [{ target: 'global', status: 'patched' }] },
        });
        const wrapper = await mountOpen();
        await setText(wrapper, 'behaviors.command.description', 'Uptime');
        await save(wrapper);
        expect(api.updateBehaviorCommand).toHaveBeenCalledWith(4, {
            description: 'Uptime',
            ifUpdatedAt: '2026-10-27T00:00:00.000Z',
        });
        expect(wrapper.find('[data-test="registration-result"]').attributes('data-tone')).toBe('ok');
        expect(wrapper.emitted('updated')).toEqual([[saved]]);
    });

    it('a taken name is shown on the name field', async () => {
        api.updateBehaviorCommand.mockRejectedValue(
            new ApiError(409, '/ping is already taken by a built-in command (globally)', 'name_conflict', 'name')
        );
        const wrapper = await mountOpen();
        await setText(wrapper, 'behaviors.command.name', 'ping');
        await save(wrapper);
        const name = commandForm(wrapper).findAll('.app-field').find((f) => f.text().includes('behaviors.command.name'))!;
        expect(name.find('.app-field__error').text()).toContain('already taken');
    });

    it('`login` is refused before sending', async () => {
        const wrapper = await mountOpen();
        await setText(wrapper, 'behaviors.command.name', 'login');
        await save(wrapper);
        expect(api.updateBehaviorCommand).not.toHaveBeenCalled();
        expect(commandForm(wrapper).text()).toContain('behaviors.command.reservedName');
    });

    it('a rename Discord refuses shows the real error and keeps the edit', async () => {
        api.updateBehaviorCommand.mockRejectedValue(
            new ApiError(502, 'Discord did not accept /uptime: Missing Access; the change was not saved', 'registration_failed', null, {
                targets: [{ target: 'global', status: 'failed', attempted: 'patch', error: 'Missing Access' }],
            })
        );
        const wrapper = await mountOpen();
        await setText(wrapper, 'behaviors.command.name', 'uptime');
        await save(wrapper);
        const result = wrapper.find('[data-test="registration-result"]');
        expect(result.attributes('data-tone')).toBe('danger');
        expect(result.text()).toContain('Missing Access');
        expect(wrapper.text()).toContain('behaviors.card.unsaved');
        expect(wrapper.emitted('updated')).toBeUndefined();
    });

    it('a stale save opens the conflict and asks for a reload', async () => {
        api.updateBehaviorCommand.mockRejectedValue(new ApiError(409, 'changed by someone else', 'validation_failed', 'ifUpdatedAt'));
        const wrapper = await mountOpen();
        await setText(wrapper, 'behaviors.command.description', 'Uptime');
        await save(wrapper);
        expect(wrapper.find('[data-test="conflict"]').exists()).toBe(true);
        expect(wrapper.emitted('reload')).toHaveLength(1);
    });
});

describe('CommandCard — a save that moves the command', () => {
    it("the card opened in the new section still shows what Discord answered", async () => {
        const moved = savedCommand({ integrationTypes: ['guild_install', 'user_install'], section: 'app' });
        api.updateBehaviorCommand.mockResolvedValue({
            command: moved,
            registration: { status: 'registered', targets: [{ target: 'global', status: 'patched' }] },
        });
        const command = vueRef(savedCommand());
        const section = vueRef('bot_dm');
        // the page: one card per section; following a move mounts a new one
        const Page = defineComponent({
            setup() {
                provideRegistrationResults();
                return () =>
                    h(CommandCard, {
                        key: section.value,
                        command: command.value,
                        expand: section.value === 'app',
                        guildNames: new Map(),
                        onUpdated: (c: CommandView) => {
                            command.value = c;
                            section.value = c.section;
                        },
                    });
            },
        });
        const wrapper = mount(Page, { global: { plugins: [i18n] }, attachTo: document.body });
        mounted.push(wrapper);
        await wrapper.find('.app-item-card__expander').trigger('click');
        await flushPromises();
        await tick(wrapper, 'integration-types', 'behaviors.card.integration.user_install');
        await save(wrapper);
        expect(section.value).toBe('app');
        expect(wrapper.find('[data-test="registration-result"]').attributes('data-tone')).toBe('ok');
    });
});

describe('CommandCard — the system command (#106)', () => {
    it('nothing is editable: no form, no inputs, no menu, toggle disabled', async () => {
        const system = savedCommand({
            name: 'login',
            isSystem: true,
            leaves: [
                savedLeaf({
                    systemKey: 'admin-login',
                    actionSource: 'builtin',
                    webhook: null,
                    options: [{ type: 'string', name: 'note', description: 'x', required: false }],
                }),
            ],
        });
        const wrapper = await mountOpen(system);
        expect(wrapper.find('form').exists()).toBe(false);
        expect(wrapper.find('input').exists()).toBe(false);
        expect(wrapper.find('.more-btn').exists()).toBe(false);
        expect(wrapper.find('[data-test="enabled-toggle"]').attributes('disabled')).toBeDefined();
    });
});

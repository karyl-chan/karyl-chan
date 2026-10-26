import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import type { CommandView } from '../../../api/behavior';
import { ApiError } from '../../../api/client';

const api = vi.hoisted(() => ({
    updateBehavior: vi.fn(),
    deleteBehavior: vi.fn(),
    addCommandLeaf: vi.fn(),
    deleteBehaviorCommand: vi.fn(),
    getBehaviorSchemas: vi.fn(),
    testBehavior: vi.fn(),
}));
const confirmMock = vi.hoisted(() => vi.fn());
vi.mock('../../../api/behavior', () => api);
vi.mock('../../../api/guilds', () => ({ listGuilds: vi.fn(async () => []), listGuildTextChannels: vi.fn(async () => []) }));
vi.mock('@karyl-chan/ui', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@karyl-chan/ui')>()),
    useConfirm: () => ({ confirm: confirmMock }),
}));

import CommandCard from './CommandCard.vue';
import { COMMAND_LEAF_SCHEMA, COMMAND_SCHEMA, keyI18n, savedCommand, savedLeaf, stubMatchMedia } from './behavior-test-support';

const i18n = keyI18n();

const container = savedCommand({
    name: 'nas',
    leaves: [
        savedLeaf({ id: 31, subcommand: 'wake', title: 'Wake' }),
        savedLeaf({ id: 32, subcommand: 'sleep', title: 'Sleep', sortOrder: 1 }),
    ],
});

const mounted: VueWrapper[] = [];
afterEach(() => mounted.splice(0).forEach((w) => w.unmount()));

async function mountOpen(command: CommandView): Promise<VueWrapper> {
    const wrapper = mount(CommandCard, {
        props: { command, guildNames: new Map() },
        global: { plugins: [i18n] },
        attachTo: document.body,
    });
    mounted.push(wrapper);
    await wrapper.find('.app-item-card__expander').trigger('click');
    await flushPromises();
    return wrapper;
}

async function setField(scope: ReturnType<VueWrapper['find']>, label: string, value: string) {
    const field = scope.findAll('.app-field').find((f) => f.find('.app-field__label').text() === label)!;
    await field.find('input').setValue(value);
}

/** Pick an item of a leaf row's ⋮ menu. */
async function leafMenu(wrapper: VueWrapper, subcommand: string, item: string) {
    const row = wrapper.find(`[data-test="leaf-${subcommand}"]`);
    await row.find('.more-btn').trigger('click');
    await flushPromises();
    // every row's menu is rendered; only the one just opened is shown
    const shown = [...document.querySelectorAll<HTMLElement>(`[data-test="${item}"]`)].find(
        (el) => el.closest<HTMLElement>('.app-menu')?.style.display !== 'none'
    )!;
    shown.click();
    await flushPromises();
}

beforeAll(stubMatchMedia);

beforeEach(() => {
    setActivePinia(createPinia());
    Object.values(api).forEach((fn) => fn.mockReset());
    confirmMock.mockReset();
    api.getBehaviorSchemas.mockResolvedValue({ command: COMMAND_SCHEMA, commandLeaf: COMMAND_LEAF_SCHEMA });
});

describe('CommandCard — the root leaf of a single command', () => {
    it('edits its options and saves them as a leaf, showing what Discord did', async () => {
        const saved = savedLeaf({ options: [{ type: 'string', name: 'host', description: 'Host', required: true }] });
        api.updateBehavior.mockResolvedValue({
            behavior: saved,
            command: savedCommand({ leaves: [saved] }),
            registration: { status: 'registered', targets: [{ target: 'global', status: 'patched' }] },
        });
        const wrapper = await mountOpen(savedCommand());
        const form = wrapper.find('[data-test="leaf-form-root"]');
        await form.find('[data-test="option-add"]').trigger('click');
        await form.find('[data-test="option-name"]').setValue('host');
        await form.find('[data-test="option-description"]').setValue('Host');
        await form.find('[data-test="option-required"]').setValue(true);
        await form.trigger('submit');
        await flushPromises();
        expect(api.updateBehavior).toHaveBeenCalledWith(21, {
            options: [{ type: 'string', name: 'host', description: 'Host', required: true }],
            ifUpdatedAt: '2026-10-27T00:00:00.000Z',
        });
        expect(wrapper.find('[data-test="registration-result"]').attributes('data-tone')).toBe('ok');
        expect(wrapper.emitted('updated')).toHaveLength(1);
    });

    it('saves 「回覆給誰看」 as the leaf’s default (#140)', async () => {
        const saved = savedLeaf({ replyVisibility: 'public' });
        api.updateBehavior.mockResolvedValue({ behavior: saved, command: savedCommand({ leaves: [saved] }) });
        const wrapper = await mountOpen(savedCommand());
        const form = wrapper.find('[data-test="leaf-form-root"]');
        const field = form.find('[data-test="reply-visibility"]');
        await field.find('button.select-trigger').trigger('click');
        await flushPromises();
        [...document.querySelectorAll<HTMLElement>('li')]
            .find((li) => li.textContent?.trim() === 'behaviors.action.replyVisibility.command.public')!
            .click();
        await flushPromises();
        await form.trigger('submit');
        await flushPromises();
        expect(api.updateBehavior).toHaveBeenCalledWith(21, {
            replyVisibility: 'public',
            ifUpdatedAt: '2026-10-27T00:00:00.000Z',
        });
    });

    it("an option rule Discord has shows on that option's row", async () => {
        const wrapper = await mountOpen(
            savedCommand({
                leaves: [
                    savedLeaf({
                        options: [
                            { type: 'string', name: 'a', description: 'a', required: false },
                            { type: 'string', name: 'b', description: 'b', required: false },
                        ],
                    }),
                ],
            })
        );
        const form = wrapper.find('[data-test="leaf-form-root"]');
        await form.findAll('[data-test="option-required"]')[1].setValue(true);
        await form.trigger('submit');
        await flushPromises();
        expect(api.updateBehavior).not.toHaveBeenCalled();
        expect(form.find('[data-test="option-error"]').text()).toBe('behaviors.command.optionRule.requiredAfterOptional');
    });

    it('the header switch turns the command off on Discord', async () => {
        const off = savedLeaf({ enabled: false });
        api.updateBehavior.mockResolvedValue({
            behavior: off,
            command: savedCommand({ leaves: [off] }),
            registration: { status: 'removed' },
        });
        const wrapper = await mountOpen(savedCommand());
        await wrapper.find('[data-test="enabled-toggle"]').trigger('click');
        await flushPromises();
        expect(api.updateBehavior).toHaveBeenCalledWith(21, { enabled: false });
        expect(wrapper.find('[data-test="registration-result"]').text()).toContain('behaviors.registration.removed');
    });
});

describe('CommandCard — subcommands (board 5)', () => {
    it('adds a subcommand and shows its generated secret once, in its row', async () => {
        const added = savedLeaf({ id: 33, subcommand: 'status', title: 'Status' });
        api.addCommandLeaf.mockResolvedValue({
            behavior: added,
            command: { ...container, leaves: [...container.leaves, added] },
            registration: { status: 'registered', targets: [{ target: 'global', status: 'patched' }] },
            secret: 'leaf-s3cret',
        });
        const wrapper = await mountOpen(container);
        await wrapper.find('[data-test="add-leaf"]').trigger('click');
        const form = wrapper.find('[data-test="add-leaf-form"]');
        await setField(form, 'behaviors.leaf.subcommand', 'status');
        await setField(form, 'behaviors.card.titleLabel', 'Status');
        await setField(form, 'behaviors.action.url', 'https://hook.example/st');
        await form.trigger('submit');
        await flushPromises();
        expect(api.addCommandLeaf).toHaveBeenCalledWith(
            4,
            expect.objectContaining({
                subcommand: 'status',
                title: 'Status',
                webhook: { url: 'https://hook.example/st', authMode: 'hmac' },
            })
        );
        const [[next]] = wrapper.emitted('updated') as [[CommandView]];
        await wrapper.setProps({ command: next });
        await flushPromises();
        expect(wrapper.find('[data-test="leaf-status"] [data-test="secret-value"]').text()).toBe('leaf-s3cret');
    });

    it('a subcommand name already in use is shown on the name field', async () => {
        api.addCommandLeaf.mockRejectedValue(new ApiError(409, "subcommand 'wake' already exists", 'invalid_tree', 'subcommand'));
        const wrapper = await mountOpen(container);
        await wrapper.find('[data-test="add-leaf"]').trigger('click');
        const form = wrapper.find('[data-test="add-leaf-form"]');
        await setField(form, 'behaviors.leaf.subcommand', 'wake');
        await setField(form, 'behaviors.card.titleLabel', 'Wake again');
        await setField(form, 'behaviors.action.url', 'https://hook.example/w');
        await form.trigger('submit');
        await flushPromises();
        const name = form.findAll('.app-field').find((f) => f.text().includes('behaviors.leaf.subcommand'))!;
        expect(name.find('.app-field__error').text()).toContain('already exists');
    });

    it('removes one of several subcommands and reports the registration', async () => {
        confirmMock.mockResolvedValue(true);
        api.deleteBehavior.mockResolvedValue({ registration: { status: 'registered', targets: [{ target: 'global', status: 'patched' }] } });
        const wrapper = await mountOpen(container);
        await leafMenu(wrapper, 'sleep', 'leaf-delete');
        expect(api.deleteBehavior).toHaveBeenCalledWith(32);
        expect(wrapper.find('[data-test="registration-result"]').exists()).toBe(true);
        expect(wrapper.emitted('reload')).toHaveLength(1);
    });

    it('the last subcommand cannot go alone: it offers to delete the command instead', async () => {
        confirmMock.mockResolvedValue(true);
        api.deleteBehaviorCommand.mockResolvedValue({ registration: { status: 'removed' } });
        const single = savedCommand({ name: 'nas', leaves: [savedLeaf({ id: 31, subcommand: 'wake' })] });
        const wrapper = await mountOpen(single);
        await leafMenu(wrapper, 'wake', 'leaf-delete');
        expect(confirmMock.mock.calls[0][0].message).toBe('behaviors.leaf.lastMessage');
        expect(api.deleteBehavior).not.toHaveBeenCalled();
        expect(api.deleteBehaviorCommand).toHaveBeenCalledWith(4);
        expect(wrapper.emitted('deleted')).toEqual([[4]]);
    });

    it('a refused leaf write shows the real error, never success', async () => {
        api.updateBehavior.mockRejectedValue(
            new ApiError(502, 'Discord did not accept /nas: Invalid Form Body', 'registration_failed', null, { targets: [] })
        );
        const wrapper = await mountOpen(container);
        await wrapper.find('[data-test="leaf-wake"] [data-test="leaf-toggle"]').trigger('click');
        await flushPromises();
        const result = wrapper.find('[data-test="registration-result"]');
        expect(result.attributes('data-tone')).toBe('danger');
        expect(result.text()).toContain('Invalid Form Body');
    });
});

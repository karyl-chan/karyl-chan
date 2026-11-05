import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import type { CommandView } from '../../../api/behavior';
import { ApiError } from '../../../api/client';

const api = vi.hoisted(() => ({
    convertToSubcommands: vi.fn(),
    getBehaviorSchemas: vi.fn(),
}));
vi.mock('../../../api/behavior', () => api);
vi.mock('../../../api/guilds', () => ({ listGuilds: vi.fn(async () => []), listGuildTextChannels: vi.fn(async () => []) }));

import CommandCard from './CommandCard.vue';
import { COMMAND_LEAF_SCHEMA, COMMAND_SCHEMA, keyI18n, savedCommand, savedLeaf, stubMatchMedia } from './behavior-test-support';

const i18n = keyI18n();
const mounted: VueWrapper[] = [];
afterEach(() => mounted.splice(0).forEach((w) => w.unmount()));

/** The dialog is teleported to <body>. */
const $ = (selector: string) => document.body.querySelector<HTMLElement>(selector);

async function openConvert(): Promise<VueWrapper> {
    const wrapper = mount(CommandCard, {
        props: { command: savedCommand(), guildNames: new Map() },
        global: { plugins: [i18n] },
        attachTo: document.body,
    });
    mounted.push(wrapper);
    await wrapper.find('.app-item-card__expander').trigger('click');
    await flushPromises();
    await wrapper.find('[data-test="add-leaf"]').trigger('click');
    await flushPromises();
    return wrapper;
}

async function typeName(value: string) {
    const input = $('[data-test="convert-name"] input') as HTMLInputElement;
    input.value = value;
    input.dispatchEvent(new Event('input'));
    await flushPromises();
}

beforeAll(stubMatchMedia);

beforeEach(() => {
    setActivePinia(createPinia());
    Object.values(api).forEach((fn) => fn.mockReset());
    api.getBehaviorSchemas.mockResolvedValue({ command: COMMAND_SCHEMA, commandLeaf: COMMAND_LEAF_SCHEMA });
});

describe('converting a single command to subcommands (board 6)', () => {
    it('adding a subcommand to /status first names its current action', async () => {
        await openConvert();
        expect($('[data-test="convert-dialog"]')!.textContent).toContain('/status');
        await typeName('Bad Name');
        expect(($('[data-test="convert-submit"]') as HTMLButtonElement).disabled).toBe(true);
        await typeName('check');
        expect($('[data-test="convert-after"]')!.textContent).toContain('/status check');
        expect(($('[data-test="convert-submit"]') as HTMLButtonElement).disabled).toBe(false);
    });

    it('converts, reports the registration and goes on to the new subcommand', async () => {
        const converted: CommandView = savedCommand({ leaves: [savedLeaf({ subcommand: 'check' })] });
        api.convertToSubcommands.mockResolvedValue({
            command: converted,
            registration: { status: 'registered', targets: [{ target: 'global', status: 'patched' }] },
        });
        const wrapper = await openConvert();
        await typeName('check');
        $('[data-test="convert-submit"]')!.click();
        await flushPromises();
        expect(api.convertToSubcommands).toHaveBeenCalledWith(4, { subcommand: 'check' });
        expect(wrapper.emitted('updated')).toEqual([[converted]]);
        await wrapper.setProps({ command: converted });
        await flushPromises();
        expect($('[data-test="convert-dialog"]')).toBeNull();
        expect(wrapper.find('[data-test="registration-result"]').attributes('data-tone')).toBe('ok');
        expect(wrapper.find('[data-test="add-leaf-form"]').exists()).toBe(true);
        // the editable rows only: no read-only leaf list next to them
        expect(wrapper.find('ul.leaves').exists()).toBe(false);
    });

    it('a conversion Discord refuses stays open with the real error', async () => {
        api.convertToSubcommands.mockRejectedValue(
            new ApiError(502, 'Discord did not accept /status: Missing Access; the change was not saved', 'registration_failed', null, {
                targets: [{ target: 'global', status: 'failed', attempted: 'patch', error: 'Missing Access' }],
            })
        );
        const wrapper = await openConvert();
        await typeName('check');
        $('[data-test="convert-submit"]')!.click();
        await flushPromises();
        expect($('[data-test="convert-dialog"] [data-test="registration-result"]')!.textContent).toContain('Missing Access');
        expect(wrapper.emitted('updated')).toBeUndefined();
    });

    it.each([
        ['invalid_tree', 409, "subcommand 'check' already exists"],
        ['validation_failed', 400, 'subcommand has an invalid format'],
    ])('a %s refusal about the name shows under the name field', async (code, status, message) => {
        api.convertToSubcommands.mockRejectedValue(new ApiError(status, message, code, 'subcommand'));
        const wrapper = await openConvert();
        await typeName('check');
        $('[data-test="convert-submit"]')!.click();
        await flushPromises();
        expect($('[data-test="convert-name"] .app-field__error')!.textContent).toBe(message);
        expect($('[data-test="convert-dialog"] [data-test="registration-result"]')).toBeNull();
        expect(wrapper.emitted('updated')).toBeUndefined();
    });
});

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import type { CommandView } from '../../../api/behavior';
import { ApiError } from '../../../api/client';

const api = vi.hoisted(() => ({
    resyncBehaviorCommand: vi.fn(),
}));
const confirmMock = vi.hoisted(() => vi.fn());
vi.mock('../../../api/behavior', () => api);
vi.mock('../../../api/guilds', () => ({ listGuilds: vi.fn(async () => []), listGuildTextChannels: vi.fn(async () => []) }));
vi.mock('@karyl-chan/ui', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@karyl-chan/ui')>()),
    useConfirm: () => ({ confirm: confirmMock }),
}));

import CommandCard from './CommandCard.vue';
import { keyI18n, savedCommand, stubMatchMedia } from './behavior-test-support';

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

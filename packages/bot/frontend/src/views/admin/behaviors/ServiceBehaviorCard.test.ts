/**
 * A Service Behavior's card (#126): locked like the login — no toggle, no
 * delete, no other action, no location or stop flag. Only its trigger
 * changes, through PUT /api/services/:id/trigger: a bot DM pattern with an
 * audience, or (from the kind tag) a global command. Only a bot owner may
 * change it; for anyone else the card is read-only.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, RouterLinkStub, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import type { CommandView, ServiceBehaviorView } from '../../../api/behavior';
import { ApiError } from '../../../api/client';

const api = vi.hoisted(() => ({
    switchServiceTrigger: vi.fn(),
    getGroupMembers: vi.fn(),
}));
vi.mock('../../../api/behavior', () => api);
vi.mock('../../../api/guilds', () => ({ listGuilds: vi.fn(async () => []), listGuildTextChannels: vi.fn(async () => []) }));

import ServiceBehaviorCard from './ServiceBehaviorCard.vue';
import { useCurrentUserStore } from '../../../stores/currentUserStore';
import { keyI18n, savedLeaf, savedTrigger, stubMatchMedia } from './behavior-test-support';

const i18n = keyI18n();
const mounted: VueWrapper[] = [];
afterEach(() => mounted.splice(0).forEach((w) => w.unmount()));
beforeAll(stubMatchMedia);

const SERVICE = { id: 3, name: 'NAS', audience: 'nas', redirectUrl: 'https://nas.example/cb' };

function onMessage(overrides: Record<string, unknown> = {}): ServiceBehaviorView {
    return {
        ...savedTrigger({
            id: 40,
            title: '登入 NAS',
            actionSource: 'service',
            webhook: null,
            patternKind: 'regex',
            patternValue: '^!login-nas$',
            stopOnMatch: true,
            ...overrides,
        }),
        service: SERVICE,
    };
}

function onCommand(): ServiceBehaviorView {
    const command: CommandView = {
        kind: 'command',
        id: 9,
        name: 'nas-login',
        description: 'Log in to the NAS',
        registration: 'global',
        guildId: null,
        integrationTypes: ['guild_install'],
        contexts: ['BotDM', 'Guild'],
        defaultMemberPermissions: null,
        isSystem: true,
        section: 'app',
        updatedAt: '2026-11-10T02:00:00.000Z',
        leaves: [savedLeaf({ id: 40, title: '登入 NAS', actionSource: 'service', webhook: null })],
    };
    return { ...command, service: SERVICE };
}

function signInAs(isOwner: boolean) {
    useCurrentUserStore().user = {
        userId: '111111111111111111',
        isOwner,
        role: isOwner ? 'owner' : 'admin',
        note: null,
        profile: null,
        capabilities: ['admin'],
    };
}

beforeEach(() => {
    setActivePinia(createPinia());
    signInAs(true);
    Object.values(api).forEach((fn) => fn.mockReset());
    api.getGroupMembers.mockResolvedValue({ groupName: 'g', members: [] });
});

async function mountOpen(behavior = onMessage()): Promise<VueWrapper> {
    const wrapper = mount(ServiceBehaviorCard, {
        props: { behavior, guildNames: new Map(), groupNames: [], groupUse: new Map() },
        global: { plugins: [i18n], stubs: { RouterLink: RouterLinkStub } },
        attachTo: document.body,
    });
    mounted.push(wrapper);
    await wrapper.find('.app-item-card__expander').trigger('click');
    await flushPromises();
    return wrapper;
}

async function setPattern(wrapper: VueWrapper, value: string) {
    const input = wrapper.findAll('input').find((i) => (i.element as HTMLInputElement).value === '^!login-nas$')!;
    await input.setValue(value);
}

/** Pick a kind on the title row's tag (its menu is teleported). */
async function pickKind(wrapper: VueWrapper, kind: 'message' | 'command') {
    await wrapper.find('[data-test="trigger-kind"]').trigger('click');
    await flushPromises();
    document.querySelector<HTMLElement>(`[data-test="convert-to-${kind}"]`)!.click();
    await flushPromises();
}

describe('ServiceBehaviorCard', () => {
    it('shows the service and its fixed action; no location, stop flag or delete', async () => {
        const wrapper = await mountOpen();
        expect(wrapper.find('[data-test="service-action"]').text()).toContain('behaviors.service.action');
        expect(wrapper.text()).toContain('https://nas.example/cb');
        expect(wrapper.text()).not.toContain('behaviors.trigger.stopOnMatch');
        expect(wrapper.find('[data-test="delete"]').exists()).toBe(false);
        expect(wrapper.findComponent(RouterLinkStub).props('to')).toBe('/admin/services');
    });

    it('saves the pattern through the trigger switch, based on the version shown', async () => {
        const saved = onMessage({ patternValue: '^!nas$', updatedAt: '2026-11-10T01:00:00.000Z' });
        api.switchServiceTrigger.mockResolvedValue({ behavior: saved, registration: null });
        const wrapper = await mountOpen();
        await setPattern(wrapper, '^!nas$');
        await wrapper.find('form').trigger('submit');
        await flushPromises();
        expect(api.switchServiceTrigger).toHaveBeenCalledWith(3, {
            kind: 'message',
            patternKind: 'regex',
            patternValue: '^!nas$',
            audienceKind: 'all',
            audienceUserId: null,
            audienceGroupName: null,
            ifUpdatedAt: '2026-10-27T00:00:00.000Z',
        });
        expect(wrapper.emitted('updated')?.[0]).toEqual([saved]);
    });

    it('switches to a command from the kind tag and shows what Discord answered', async () => {
        api.switchServiceTrigger.mockResolvedValue({
            behavior: onCommand(),
            registration: { status: 'registered', targets: [{ target: 'global', outcome: 'created' }] },
        });
        const wrapper = await mountOpen();
        await pickKind(wrapper, 'command');
        expect(wrapper.find('[data-test="service-command-name"] input').exists()).toBe(true);
        await wrapper.find('form').trigger('submit');
        await flushPromises();
        expect(api.switchServiceTrigger).toHaveBeenCalledWith(3, {
            kind: 'command',
            name: 'nas-login',
            description: '登入 NAS',
            integrationTypes: ['guild_install'],
            contexts: ['BotDM'],
            ifUpdatedAt: '2026-10-27T00:00:00.000Z',
        });
        expect(wrapper.emitted('updated')?.[0]).toEqual([onCommand()]);
    });

    it('a command trigger edits its name, and goes back to the default pattern', async () => {
        api.switchServiceTrigger.mockResolvedValue({ behavior: onMessage(), registration: { status: 'removed' } });
        const wrapper = await mountOpen(onCommand());
        expect(wrapper.find('[data-test="service-summary"]').text()).toBe('/nas-login');
        await pickKind(wrapper, 'message');
        await wrapper.find('form').trigger('submit');
        await flushPromises();
        expect(api.switchServiceTrigger).toHaveBeenCalledWith(3, expect.objectContaining({
            kind: 'message',
            patternValue: '^!login-nas$',
            ifUpdatedAt: '2026-11-10T02:00:00.000Z',
        }));
    });

    it("puts the server's refusal on the pattern; a stale save asks for a reload", async () => {
        api.switchServiceTrigger.mockRejectedValueOnce(
            new ApiError(400, 'this trigger also matches "!login"', 'validation_failed', 'patternValue')
        );
        const wrapper = await mountOpen();
        await setPattern(wrapper, '^!');
        await wrapper.find('form').trigger('submit');
        await flushPromises();
        expect(wrapper.text()).toContain('this trigger also matches "!login"');

        api.switchServiceTrigger.mockRejectedValueOnce(new ApiError(409, 'changed', 'validation_failed', 'ifUpdatedAt'));
        await wrapper.find('form').trigger('submit');
        await flushPromises();
        expect(wrapper.emitted('reload')).toHaveLength(1);
    });

    it('is read-only for an admin who is not the owner', async () => {
        signInAs(false);
        const wrapper = await mountOpen();
        expect(wrapper.find('[data-test="owner-only"]').exists()).toBe(true);
        expect(wrapper.find('fieldset').attributes('disabled')).toBeDefined();
        expect(wrapper.find('[data-test="save"]').exists()).toBe(false);
        expect(wrapper.find('[data-test="services-link"]').exists()).toBe(false);
    });
});

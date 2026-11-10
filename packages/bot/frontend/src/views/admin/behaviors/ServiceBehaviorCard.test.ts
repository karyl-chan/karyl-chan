/**
 * A Service Behavior's card (#126): locked like the login — no toggle, no
 * delete, no conversion, no location or stop flag — and only the trigger
 * (pattern, audience) is saved, through PATCH /api/behaviors/:id.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, RouterLinkStub, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import type { ServiceBehaviorView } from '../../../api/behavior';
import { ApiError } from '../../../api/client';

const api = vi.hoisted(() => ({
    updateServiceTrigger: vi.fn(),
    getGroupMembers: vi.fn(),
}));
vi.mock('../../../api/behavior', () => api);

import ServiceBehaviorCard from './ServiceBehaviorCard.vue';
import { keyI18n, savedTrigger, stubMatchMedia } from './behavior-test-support';

const i18n = keyI18n();
const mounted: VueWrapper[] = [];
afterEach(() => mounted.splice(0).forEach((w) => w.unmount()));
beforeAll(stubMatchMedia);

function serviceBehavior(overrides: Partial<ServiceBehaviorView> = {}): ServiceBehaviorView {
    return {
        ...savedTrigger({
            id: 40,
            title: '登入 NAS',
            actionSource: 'service',
            webhook: null,
            patternKind: 'regex',
            patternValue: '^!login-nas$',
            stopOnMatch: true,
        }),
        service: { id: 3, name: 'NAS', audience: 'nas', redirectUrl: 'https://nas.example/cb' },
        ...overrides,
    };
}

beforeEach(() => {
    setActivePinia(createPinia());
    Object.values(api).forEach((fn) => fn.mockReset());
    api.getGroupMembers.mockResolvedValue({ groupName: 'g', members: [] });
});

async function mountOpen(behavior = serviceBehavior()): Promise<VueWrapper> {
    const wrapper = mount(ServiceBehaviorCard, {
        props: { behavior, groupNames: [], groupUse: new Map() },
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

describe('ServiceBehaviorCard', () => {
    it('shows the service and its fixed action; no location, stop flag, delete or working toggle', async () => {
        const wrapper = await mountOpen();
        expect(wrapper.find('[data-test="service-action"]').text()).toContain('behaviors.service.action');
        expect(wrapper.text()).toContain('https://nas.example/cb');
        expect(wrapper.text()).not.toContain('behaviors.trigger.stopOnMatch');
        expect(wrapper.find('[data-test="delete"]').exists()).toBe(false);
        expect(wrapper.find('[data-test="trigger-kind"]').exists()).toBe(false);
        expect(wrapper.findComponent(RouterLinkStub).props('to')).toBe('/admin/services');
        const toggle = wrapper.find('input[type="checkbox"][disabled], [role="switch"]');
        expect(toggle.exists()).toBe(true);
    });

    it('saves only the trigger, based on the version shown', async () => {
        const saved = serviceBehavior({ patternKind: 'regex', patternValue: '^!nas$', updatedAt: '2026-11-10T01:00:00.000Z' });
        api.updateServiceTrigger.mockResolvedValue({ behavior: saved });
        const wrapper = await mountOpen();
        await setPattern(wrapper, '^!nas$');
        await wrapper.find('form').trigger('submit');
        await flushPromises();
        expect(api.updateServiceTrigger).toHaveBeenCalledTimes(1);
        expect(api.updateServiceTrigger).toHaveBeenCalledWith(40, {
            patternValue: '^!nas$',
            ifUpdatedAt: '2026-10-27T00:00:00.000Z',
        });
        expect(wrapper.emitted('updated')?.[0]).toEqual([saved]);
    });

    it("puts the server's refusal on the pattern", async () => {
        api.updateServiceTrigger.mockRejectedValue(
            new ApiError(400, 'this trigger also matches "!login"', 'validation_failed', 'patternValue')
        );
        const wrapper = await mountOpen();
        await setPattern(wrapper, '^!');
        await wrapper.find('form').trigger('submit');
        await flushPromises();
        expect(wrapper.text()).toContain('this trigger also matches "!login"');
        expect(wrapper.emitted('updated')).toBeUndefined();
    });

    it('a stale save asks the page to reload', async () => {
        api.updateServiceTrigger.mockRejectedValue(new ApiError(409, 'changed', 'validation_failed', 'ifUpdatedAt'));
        const wrapper = await mountOpen();
        await setPattern(wrapper, '^!nas$');
        await wrapper.find('form').trigger('submit');
        await flushPromises();
        expect(wrapper.emitted('reload')).toHaveLength(1);
    });
});

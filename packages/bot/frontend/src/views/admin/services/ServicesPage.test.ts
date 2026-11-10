/**
 * The services page (#126): lists services, adds one (checked before it is
 * sent: a name, a slug audience, an https URL), edits one with the version
 * it was loaded at, and deletes one after a confirm.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, RouterLinkStub, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import type { ServiceView } from '../../../api/services';
import { ApiError } from '../../../api/client';

const api = vi.hoisted(() => ({
    listServices: vi.fn(),
    createService: vi.fn(),
    updateService: vi.fn(),
    deleteService: vi.fn(),
}));
vi.mock('../../../api/services', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../../api/services')>()),
    ...api,
}));
const confirmMock = vi.hoisted(() => vi.fn());
vi.mock('@karyl-chan/ui', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@karyl-chan/ui')>()),
    useConfirm: () => ({ confirm: confirmMock }),
}));

import ServicesPage from './ServicesPage.vue';
import { keyI18n, stubMatchMedia } from '../behaviors/behavior-test-support';

const i18n = keyI18n();
const mounted: VueWrapper[] = [];
afterEach(() => mounted.splice(0).forEach((w) => w.unmount()));
beforeAll(stubMatchMedia);

function service(overrides: Partial<ServiceView> = {}): ServiceView {
    return {
        id: 1,
        name: 'NAS',
        audience: 'nas',
        redirectUrl: 'https://nas.example/cb',
        behaviorId: 40,
        trigger: { kind: 'message', patternKind: 'regex', patternValue: '^!login-nas$', audienceKind: 'all' },
        createdAt: '2026-11-10T00:00:00.000Z',
        updatedAt: '2026-11-10T00:00:00.000Z',
        ...overrides,
    };
}

beforeEach(() => {
    setActivePinia(createPinia());
    Object.values(api).forEach((fn) => fn.mockReset());
    confirmMock.mockReset();
    api.listServices.mockResolvedValue([service()]);
});

async function mountPage(): Promise<VueWrapper> {
    const wrapper = mount(ServicesPage, {
        global: { plugins: [i18n], stubs: { RouterLink: RouterLinkStub } },
        attachTo: document.body,
    });
    mounted.push(wrapper);
    await flushPromises();
    return wrapper;
}

async function fill(wrapper: VueWrapper, field: string, value: string) {
    await wrapper.find(`[data-test="${field}"] input`).setValue(value);
}

describe('ServicesPage', () => {
    it('lists the services with their trigger and the JWKS URL', async () => {
        const wrapper = await mountPage();
        const rows = wrapper.findAll('[data-test="service-row"]');
        expect(rows).toHaveLength(1);
        expect(rows[0].text()).toContain('NAS');
        expect(rows[0].text()).toContain('https://nas.example/cb');
        expect(rows[0].find('[data-test="trigger"]').text()).toContain('behaviors.card.pattern.regex');
        expect(wrapper.find('[data-test="jwks"]').text()).toContain('/.well-known/jwks.json');
    });

    it('says when there are none', async () => {
        api.listServices.mockResolvedValue([]);
        const wrapper = await mountPage();
        expect(wrapper.find('[data-test="empty"]').exists()).toBe(true);
    });

    it('adds a service', async () => {
        const created = service({ id: 2, name: 'Wiki', audience: 'wiki', redirectUrl: 'https://wiki.example/login' });
        api.createService.mockResolvedValue(created);
        const wrapper = await mountPage();
        await wrapper.find('[data-test="add-service"]').trigger('click');
        await fill(wrapper, 'service-name', ' Wiki ');
        await fill(wrapper, 'service-audience', 'wiki');
        await fill(wrapper, 'service-redirect', 'https://wiki.example/login');
        await wrapper.find('[data-test="add-form"]').trigger('submit');
        await flushPromises();
        expect(api.createService).toHaveBeenCalledWith({
            name: 'Wiki',
            audience: 'wiki',
            redirectUrl: 'https://wiki.example/login',
        });
        expect(wrapper.findAll('[data-test="service-row"]')).toHaveLength(2);
        expect(wrapper.find('[data-test="add-form"]').exists()).toBe(false);
    });

    it('checks the form before sending: audience slug, https URL', async () => {
        const wrapper = await mountPage();
        await wrapper.find('[data-test="add-service"]').trigger('click');
        await fill(wrapper, 'service-name', 'Wiki');
        await fill(wrapper, 'service-audience', 'Wiki!');
        await fill(wrapper, 'service-redirect', 'http://wiki.example');
        await wrapper.find('[data-test="add-form"]').trigger('submit');
        await flushPromises();
        expect(api.createService).not.toHaveBeenCalled();
        expect(wrapper.text()).toContain('services.error.audience');
        expect(wrapper.text()).toContain('services.error.https');
    });

    it("shows the server's refusal on its field", async () => {
        api.createService.mockRejectedValue(
            new ApiError(409, 'audience "nas" is already used by another service', 'name_conflict', 'audience')
        );
        const wrapper = await mountPage();
        await wrapper.find('[data-test="add-service"]').trigger('click');
        await fill(wrapper, 'service-name', 'Other');
        await fill(wrapper, 'service-audience', 'nas');
        await fill(wrapper, 'service-redirect', 'https://other.example');
        await wrapper.find('[data-test="add-form"]').trigger('submit');
        await flushPromises();
        expect(wrapper.find('[data-test="service-audience"]').text()).toContain('already used');
    });

    it('edits a service with the version it was loaded at; warns about an audience change', async () => {
        api.updateService.mockResolvedValue(service({ name: 'Home NAS', audience: 'home' }));
        const wrapper = await mountPage();
        await wrapper.find('[data-test="edit"]').trigger('click');
        await fill(wrapper, 'service-name', 'Home NAS');
        await fill(wrapper, 'service-audience', 'home');
        expect(wrapper.find('[data-test="audience-warning"]').exists()).toBe(true);
        await wrapper.find('[data-test="service-row"] form').trigger('submit');
        await flushPromises();
        expect(api.updateService).toHaveBeenCalledWith(1, {
            name: 'Home NAS',
            audience: 'home',
            ifUpdatedAt: '2026-11-10T00:00:00.000Z',
        });
        expect(wrapper.find('[data-test="service-row"]').text()).toContain('Home NAS');
    });

    it('deletes a service after the confirm', async () => {
        api.deleteService.mockResolvedValue(undefined);
        confirmMock.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
        const wrapper = await mountPage();
        await wrapper.find('[data-test="delete"]').trigger('click');
        await flushPromises();
        expect(api.deleteService).not.toHaveBeenCalled();
        await wrapper.find('[data-test="delete"]').trigger('click');
        await flushPromises();
        expect(api.deleteService).toHaveBeenCalledWith(1);
        expect(wrapper.findAll('[data-test="service-row"]')).toHaveLength(0);
    });
});

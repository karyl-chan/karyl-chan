import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { ApiError } from '../../../api/client';
import type { BehaviorDelivery } from '../../../api/behavior';
import { keyI18n } from './behavior-test-support';

const api = vi.hoisted(() => ({ getBehaviorDeliveries: vi.fn() }));
vi.mock('../../../api/behavior', () => api);

import BehaviorDeliveries from './BehaviorDeliveries.vue';

function delivery(overrides: Partial<BehaviorDelivery> = {}): BehaviorDelivery {
    return {
        id: 1,
        firedAt: new Date().toISOString(),
        via: 'message',
        ok: true,
        httpStatus: 200,
        durationMs: 42,
        errorCode: null,
        error: null,
        verified: null,
        deferred: false,
        ...overrides,
    };
}

function mountList() {
    return mount(BehaviorDeliveries, { props: { behaviorId: 7 }, global: { plugins: [keyI18n()] } });
}

async function expand(wrapper: ReturnType<typeof mountList>) {
    await wrapper.find('[data-test="deliveries-toggle"]').trigger('click');
    await flushPromises();
}

beforeEach(() => {
    api.getBehaviorDeliveries.mockReset();
});

describe('BehaviorDeliveries', () => {
    it('loads only when expanded', async () => {
        api.getBehaviorDeliveries.mockResolvedValue({ deliveries: [] });
        const wrapper = mountList();
        await flushPromises();
        expect(api.getBehaviorDeliveries).not.toHaveBeenCalled();
        expect(wrapper.find('[data-test="deliveries-toggle"]').attributes('aria-expanded')).toBe('false');

        await expand(wrapper);

        expect(api.getBehaviorDeliveries).toHaveBeenCalledWith(7);
        expect(wrapper.find('[data-test="deliveries-toggle"]').attributes('aria-expanded')).toBe('true');
    });

    it('marks a deferred delivery, and only that one', async () => {
        api.getBehaviorDeliveries.mockResolvedValue({
            deliveries: [delivery({ id: 2, via: 'command', deferred: true }), delivery({ id: 1, via: 'command' })],
        });
        const wrapper = mountList();

        await expand(wrapper);

        const rows = wrapper.findAll('[data-test="delivery-row"]');
        expect(rows[0].get('[data-test="delivery-deferred"]').text()).toBe('behaviors.deliveries.deferred');
        expect(rows[0].text()).toContain('behaviors.deliveries.ok');
        expect(rows[1].find('[data-test="delivery-deferred"]').exists()).toBe(false);
    });

    it('renders one row per delivery: outcome, status, latency, error and signature', async () => {
        api.getBehaviorDeliveries.mockResolvedValue({
            deliveries: [
                delivery({ id: 2, httpStatus: 204, durationMs: 85, verified: 'hmac' }),
                delivery({ id: 1, ok: false, httpStatus: 500, durationMs: 1200, errorCode: 'http_error', error: 'Internal Server Error' }),
            ],
        });
        const wrapper = mountList();

        await expand(wrapper);

        const rows = wrapper.findAll('[data-test="delivery-row"]');
        expect(rows).toHaveLength(2);
        expect(rows[0].text()).toContain('behaviors.deliveries.ok');
        expect(rows[0].get('[data-test="delivery-status"]').text()).toBe('HTTP 204');
        expect(rows[0].get('[data-test="delivery-duration"]').text()).toBe('85 ms');
        expect(rows[0].text()).toContain('behaviors.deliveries.verified.hmac');
        expect(rows[1].text()).toContain('behaviors.deliveries.failed');
        expect(rows[1].get('[data-test="delivery-status"]').text()).toBe('HTTP 500');
        expect(rows[1].text()).toContain('http_error');
        expect(rows[1].text()).toContain('Internal Server Error');
    });

    it('a delivery that never reached the webhook shows no status or latency', async () => {
        api.getBehaviorDeliveries.mockResolvedValue({
            deliveries: [delivery({ via: 'command', ok: false, httpStatus: null, durationMs: null, errorCode: 'defer_failed', error: 'Discord refused the deferral: Unknown interaction' })],
        });
        const wrapper = mountList();

        await expand(wrapper);

        const row = wrapper.get('[data-test="delivery-row"]');
        expect(row.text()).toContain('defer_failed');
        expect(row.find('[data-test="delivery-duration"]').exists()).toBe(false);
        expect(row.find('[data-test="delivery-status"]').exists()).toBe(false);
    });

    it('an empty log says so', async () => {
        api.getBehaviorDeliveries.mockResolvedValue({ deliveries: [] });
        const wrapper = mountList();

        await expand(wrapper);

        expect(wrapper.find('[data-test="delivery-row"]').exists()).toBe(false);
        expect(wrapper.find('[data-test="deliveries-empty"]').text()).toBe('behaviors.deliveries.empty');
    });

    it('a refused load shows the error', async () => {
        api.getBehaviorDeliveries.mockRejectedValue(new ApiError(404, 'behavior 7 does not exist', 'not_found'));
        const wrapper = mountList();

        await expand(wrapper);

        expect(wrapper.find('[role="alert"]').exists()).toBe(true);
    });
});

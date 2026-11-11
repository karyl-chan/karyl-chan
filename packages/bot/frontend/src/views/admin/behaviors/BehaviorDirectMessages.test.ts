import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import type { BehaviorDmLogEntry } from '../../../api/behavior';
import { keyI18n } from './behavior-test-support';

const api = vi.hoisted(() => ({
    getBehaviorDmAllowlist: vi.fn(),
    replaceBehaviorDmAllowlist: vi.fn(),
    getBehaviorDmLog: vi.fn(),
    getGroupMembers: vi.fn(),
    replaceGroupMembers: vi.fn(),
}));
vi.mock('../../../api/behavior', () => api);
vi.mock('../../../api/discord', () => ({ fetchUserSummaries: vi.fn(async () => []) }));

import BehaviorDirectMessages from './BehaviorDirectMessages.vue';

const A = '111111111111111111';
const B = '222222222222222222';

function entry(overrides: Partial<BehaviorDmLogEntry> = {}): BehaviorDmLogEntry {
    return { id: 1, recipientUserId: A, triggererUserId: B, outcome: 'sent', at: new Date().toISOString(), ...overrides };
}

function mountSection() {
    return mount(BehaviorDirectMessages, { props: { behaviorId: 7 }, global: { plugins: [keyI18n()] } });
}

async function expand(wrapper: ReturnType<typeof mountSection>) {
    await wrapper.find('[data-test="dm-toggle"]').trigger('click');
    await flushPromises();
}

beforeEach(() => {
    setActivePinia(createPinia());
    for (const fn of Object.values(api)) fn.mockReset();
    api.getBehaviorDmAllowlist.mockResolvedValue({ userIds: [], groupNames: [] });
    api.getBehaviorDmLog.mockResolvedValue({ entries: [] });
    api.getGroupMembers.mockResolvedValue({ groupName: 'ops', members: [] });
});

describe('BehaviorDirectMessages', () => {
    it('loads the list and the log only when expanded', async () => {
        const wrapper = mountSection();
        await flushPromises();
        expect(api.getBehaviorDmAllowlist).not.toHaveBeenCalled();

        await expand(wrapper);

        expect(api.getBehaviorDmAllowlist).toHaveBeenCalledWith(7);
        expect(api.getBehaviorDmLog).toHaveBeenCalledWith(7);
        expect(wrapper.get('[data-test="dm-rule"]').text()).toBe('behaviors.directMessages.ruleNone');
        expect(wrapper.find('[data-test="dm-log-empty"]').exists()).toBe(true);
    });

    it('shows the list: users, and groups with their member panels', async () => {
        api.getBehaviorDmAllowlist.mockResolvedValue({ userIds: [A], groupNames: ['ops'] });
        const wrapper = mountSection();
        await expand(wrapper);

        expect(wrapper.get('[data-test="dm-rule"]').text()).toBe('behaviors.directMessages.ruleList');
        expect(wrapper.findAll('[data-test="dm-user"]').map((c) => c.text())).toEqual([A]);
        expect(wrapper.findAll('[data-test="dm-group"]').map((c) => c.text())).toEqual(['ops']);
        expect(api.getGroupMembers).toHaveBeenCalledWith('ops');
    });

    it('adding a user saves the whole list', async () => {
        api.replaceBehaviorDmAllowlist.mockResolvedValue({ userIds: [B], groupNames: [] });
        const wrapper = mountSection();
        await expand(wrapper);

        await wrapper.get('[data-test="dm-user-input"] input').setValue(B);
        await wrapper.get('[data-test="dm-add-user"]').trigger('click');
        await flushPromises();

        expect(api.replaceBehaviorDmAllowlist).toHaveBeenCalledWith(7, { userIds: [B], groupNames: [] });
        expect(wrapper.findAll('[data-test="dm-user"]')).toHaveLength(1);
        expect((wrapper.get('[data-test="dm-user-input"] input').element as HTMLInputElement).value).toBe('');
    });

    it('refuses a user id that is not a snowflake, without saving', async () => {
        const wrapper = mountSection();
        await expand(wrapper);

        await wrapper.get('[data-test="dm-user-input"] input').setValue('mika');
        await wrapper.get('[data-test="dm-add-user"]').trigger('click');
        await flushPromises();

        expect(api.replaceBehaviorDmAllowlist).not.toHaveBeenCalled();
        expect(wrapper.get('[role="alert"]').text()).toBe('behaviors.directMessages.badUserId');
    });

    it('adding and removing a group saves the list', async () => {
        api.getBehaviorDmAllowlist.mockResolvedValue({ userIds: [A], groupNames: [] });
        api.replaceBehaviorDmAllowlist.mockResolvedValueOnce({ userIds: [A], groupNames: ['ops'] });
        const wrapper = mountSection();
        await expand(wrapper);

        await wrapper.get('[data-test="dm-group-input"] input').setValue(' ops ');
        await wrapper.get('[data-test="dm-add-group"]').trigger('click');
        await flushPromises();
        expect(api.replaceBehaviorDmAllowlist).toHaveBeenLastCalledWith(7, { userIds: [A], groupNames: ['ops'] });

        api.replaceBehaviorDmAllowlist.mockResolvedValueOnce({ userIds: [A], groupNames: [] });
        await wrapper.get('[data-test="dm-group"] button').trigger('click');
        await flushPromises();
        expect(api.replaceBehaviorDmAllowlist).toHaveBeenLastCalledWith(7, { userIds: [A], groupNames: [] });
        expect(wrapper.find('[data-test="dm-group"]').exists()).toBe(false);
    });

    it('lists the log: outcome, recipient and triggerer per row', async () => {
        api.getBehaviorDmLog.mockResolvedValue({
            entries: [entry({ id: 2, outcome: 'not_allowed' }), entry({ id: 1 })],
        });
        const wrapper = mountSection();
        await expand(wrapper);

        const rows = wrapper.findAll('[data-test="dm-log-row"]');
        expect(rows).toHaveLength(2);
        expect(rows.map((r) => r.get('[data-test="dm-outcome"]').text())).toEqual([
            'behaviors.directMessages.outcome.not_allowed',
            'behaviors.directMessages.outcome.sent',
        ]);
        expect(rows[0]!.text()).toContain('behaviors.directMessages.logLine');
    });
});

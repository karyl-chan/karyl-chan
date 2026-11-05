import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createI18n } from 'vue-i18n';
import { createPinia, setActivePinia } from 'pinia';
import { ApiError } from '../../../api/client';

const api = vi.hoisted(() => ({ getGroupMembers: vi.fn(), replaceGroupMembers: vi.fn() }));
vi.mock('../../../api/behavior', () => api);
vi.mock('../../../api/discord', () => ({ fetchUserSummaries: vi.fn(async () => []) }));

import GroupMembersPanel from './GroupMembersPanel.vue';

const i18n = createI18n({ legacy: false, locale: 'en', missingWarn: false, fallbackWarn: false, messages: { en: { behaviors: { errors: { withDetail: '{reason} ({detail})' } } } } });
const A = '111111111111111111';
const B = '222222222222222222';

function mountPanel(usedBy = 1) {
    return mount(GroupMembersPanel, { props: { groupName: 'ops', usedBy }, global: { plugins: [i18n] } });
}

beforeEach(() => {
    setActivePinia(createPinia());
    api.getGroupMembers.mockReset().mockResolvedValue({ groupName: 'ops', members: [A] });
    api.replaceGroupMembers.mockReset();
});

describe('GroupMembersPanel', () => {
    it('adding a member saves the whole list', async () => {
        api.replaceGroupMembers.mockResolvedValue({ groupName: 'ops', members: [A, B] });
        const wrapper = mountPanel();
        await flushPromises();
        await wrapper.find('input').setValue(B);
        await wrapper.find('[data-test="add-member"]').trigger('click');
        await flushPromises();
        expect(api.replaceGroupMembers).toHaveBeenCalledWith('ops', [A, B]);
        expect(wrapper.findAll('.chip')).toHaveLength(2);
        expect((wrapper.find('input').element as HTMLInputElement).value).toBe('');
    });

    it('Enter in the id field adds, without submitting the card around it', async () => {
        api.replaceGroupMembers.mockResolvedValue({ groupName: 'ops', members: [A, B] });
        const wrapper = mountPanel();
        await flushPromises();
        await wrapper.find('input').setValue(B);
        await wrapper.find('input').trigger('keydown', { key: 'Enter' });
        await flushPromises();
        expect(api.replaceGroupMembers).toHaveBeenCalledWith('ops', [A, B]);
        expect(wrapper.find('form').exists()).toBe(false);
    });

    it('shows a refusal and keeps what was typed', async () => {
        api.replaceGroupMembers.mockRejectedValue(new ApiError(400, 'userIds.1 must be a Discord id', 'validation_failed', 'userIds.1'));
        const wrapper = mountPanel();
        await flushPromises();
        await wrapper.find('input').setValue('12');
        await wrapper.find('[data-test="add-member"]').trigger('click');
        await flushPromises();
        expect(wrapper.find('[role="alert"]').text()).toContain('userIds.1 must be a Discord id');
        expect((wrapper.find('input').element as HTMLInputElement).value).toBe('12');
    });

    it('says when other triggers share the list', async () => {
        const wrapper = mountPanel(3);
        await flushPromises();
        expect(wrapper.text()).toContain('behaviors.group.shared');
    });
});

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import type { BehaviorTargetView } from '../../../api/behavior';
import { ApiError } from '../../../api/client';

const api = vi.hoisted(() => ({
    deleteBehaviorTarget: vi.fn(),
    getGroupMembers: vi.fn(),
    replaceGroupMembers: vi.fn(),
}));
const confirmMock = vi.hoisted(() => vi.fn());
vi.mock('../../../api/behavior', () => api);
vi.mock('../../../api/discord', () => ({ fetchUserSummaries: vi.fn(async () => []) }));
vi.mock('@karyl-chan/ui', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@karyl-chan/ui')>()),
    useConfirm: () => ({ confirm: confirmMock }),
}));

import TargetHeader from './TargetHeader.vue';
import { useCurrentUserStore } from '../../../stores/currentUserStore';
import { builtinTarget, createdTarget, keyI18n, stubMatchMedia } from './behavior-test-support';

const i18n = keyI18n();
const USER = '323456789012345678';

beforeAll(stubMatchMedia);

beforeEach(() => {
    setActivePinia(createPinia());
    Object.values(api).forEach((fn) => fn.mockReset());
    confirmMock.mockReset().mockResolvedValue(true);
    api.getGroupMembers.mockResolvedValue({ groupName: 'vip', members: [USER] });
});

function signInAs(isOwner: boolean) {
    useCurrentUserStore().user = { userId: '111111111111111111', isOwner } as never;
}

function mountHeader(target: BehaviorTargetView, count = 0) {
    return mount(TargetHeader, {
        props: { target, label: 'Label', count },
        global: { plugins: [i18n] },
    });
}

const deleteButton = (wrapper: ReturnType<typeof mountHeader>) => wrapper.find('[data-test="delete-target"]');

describe('TargetHeader', () => {
    it('a built-in target cannot be deleted', () => {
        const wrapper = mountHeader(builtinTarget('bot_dm'));
        expect(wrapper.find('.title').text()).toBe('Label');
        expect(wrapper.find('.kind-badge').text()).toBe('behaviors.target.kind.bot_dm');
        expect(deleteButton(wrapper).exists()).toBe(false);
    });

    it('asks for a new behavior', async () => {
        const wrapper = mountHeader(builtinTarget('bot_dm'));
        await wrapper.find('[data-test="add-behavior"]').trigger('click');
        expect(wrapper.emitted('add')).toHaveLength(1);
    });

    it('deletes a created target nothing uses, after a confirmation', async () => {
        const target = createdTarget(`user:${USER}`, { id: 12 });
        api.deleteBehaviorTarget.mockResolvedValue(undefined);
        const wrapper = mountHeader(target);

        await deleteButton(wrapper).trigger('click');
        await flushPromises();
        expect(confirmMock.mock.calls[0][0].message).toBe('behaviors.target.delete.message');
        expect(api.deleteBehaviorTarget).toHaveBeenCalledWith(12);
        expect(wrapper.emitted('deleted')).toEqual([[target]]);
    });

    it('does nothing when the confirmation is declined', async () => {
        confirmMock.mockResolvedValue(false);
        const wrapper = mountHeader(createdTarget(`user:${USER}`));
        await deleteButton(wrapper).trigger('click');
        await flushPromises();
        expect(api.deleteBehaviorTarget).not.toHaveBeenCalled();
    });

    it('cannot delete a target that still has behaviors, and says why', async () => {
        const wrapper = mountHeader(createdTarget(`user:${USER}`), 2);
        expect(deleteButton(wrapper).attributes('disabled')).toBeDefined();
        expect(deleteButton(wrapper).attributes('title')).toBe('behaviors.target.delete.hasBehaviors');
        await deleteButton(wrapper).trigger('click');
        expect(confirmMock).not.toHaveBeenCalled();
    });

    it('shows the refusal when the server says the target is in use after all', async () => {
        api.deleteBehaviorTarget.mockRejectedValue(new ApiError(409, 'still in use', 'target_in_use'));
        const wrapper = mountHeader(createdTarget(`user:${USER}`));
        await deleteButton(wrapper).trigger('click');
        await flushPromises();
        expect(wrapper.find('[data-test="target-error"]').text()).toContain('behaviors.errors.withDetail');
        expect(wrapper.emitted('deleted')).toBeUndefined();
    });
});

describe('TargetHeader — a group', () => {
    it('edits the members right there, and reports their count', async () => {
        const wrapper = mountHeader(createdTarget('group:vip'));
        await flushPromises();
        expect(api.getGroupMembers).toHaveBeenCalledWith('vip');
        expect(wrapper.find('[data-test="add-member"]').exists()).toBe(true);
        expect(wrapper.emitted('members')).toEqual([[1]]);
    });

    it('warns that deleting it deletes its member list', async () => {
        api.deleteBehaviorTarget.mockResolvedValue(undefined);
        const wrapper = mountHeader(createdTarget('group:vip'));
        await deleteButton(wrapper).trigger('click');
        await flushPromises();
        expect(confirmMock.mock.calls[0][0].message).toBe('behaviors.target.delete.messageGroup');
    });

    it('cannot be deleted while a DM allowlist names it, and shows how many do', async () => {
        const wrapper = mountHeader(createdTarget('group:vip', { allowlistRefs: 2 }));
        await flushPromises();
        expect(wrapper.find('[data-test="allowlist-refs"]').text()).toBe('behaviors.target.allowlistRefs');
        expect(deleteButton(wrapper).attributes('disabled')).toBeDefined();
        expect(deleteButton(wrapper).attributes('title')).toBe('behaviors.target.delete.inAllowlists');
    });

    it('a group a service’s login uses is read-only for an admin who is not an owner', async () => {
        signInAs(false);
        const locked = mountHeader(createdTarget('group:vip', { ownerOnly: true }));
        await flushPromises();
        expect(locked.find('[data-test="add-member"]').exists()).toBe(false);

        signInAs(true);
        const open = mountHeader(createdTarget('group:vip', { ownerOnly: true }));
        await flushPromises();
        expect(open.find('[data-test="add-member"]').exists()).toBe(true);
    });
});

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { computed, defineComponent, h } from 'vue';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import type { BehaviorDmLogEntry } from '../../../api/behavior';
import { BUILTIN_TARGETS, createdTarget, keyI18n, stubMatchMedia } from './behavior-test-support';
import { TARGET_DIRECTORY, type TargetDirectory } from './target-directory';
import { NO_NAMES } from './target-labels';
import { useDmAllowlistDraft, type DmAllowlistDraft } from './use-dm-allowlist-draft';

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

beforeAll(stubMatchMedia);

// attached to <body> (the group select teleports its options there): take each one down again
const mounted: VueWrapper[] = [];
afterEach(() => mounted.splice(0).forEach((w) => w.unmount()));

const openTarget = vi.fn();
/** The group targets the page lists: the allowlist's group select offers them. */
const directory: TargetDirectory = {
    targets: computed(() => [...BUILTIN_TARGETS, createdTarget('group:ops'), createdTarget('group:vip')]),
    names: computed(() => NO_NAMES),
    created: () => undefined,
    open: openTarget,
};

/** The draft the surrounding form owns: what its save and cancel act on. */
let allowlist: DmAllowlistDraft;

/** The section inside a form that owns its allowlist draft, as a card does. */
const Host = defineComponent({
    setup() {
        allowlist = useDmAllowlistDraft(7);
        return () => h(BehaviorDirectMessages, { allowlist });
    },
});

function mountSection() {
    const wrapper = mount(Host, {
        global: { plugins: [keyI18n()], provide: { [TARGET_DIRECTORY as symbol]: directory } },
        attachTo: document.body,
    });
    mounted.push(wrapper);
    return wrapper;
}

/** Pick a group in the allowlist's group select (its options are teleported). */
async function chooseGroup(wrapper: ReturnType<typeof mountSection>, name: string) {
    await wrapper.get('[data-test="dm-group-input"] button.select-trigger').trigger('click');
    await flushPromises();
    [...document.querySelectorAll<HTMLElement>('li')].find((li) => li.textContent?.trim() === name)!.click();
    await flushPromises();
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

    it('adding a user only edits the draft: the form’s save writes the whole list', async () => {
        api.replaceBehaviorDmAllowlist.mockResolvedValue({ userIds: [B], groupNames: [] });
        const wrapper = mountSection();
        await expand(wrapper);
        expect(wrapper.find('[data-test="dm-unsaved"]').exists()).toBe(false);

        await wrapper.get('[data-test="dm-user-input"] input').setValue(B);
        await wrapper.get('[data-test="dm-add-user"]').trigger('click');
        await flushPromises();

        expect(api.replaceBehaviorDmAllowlist).not.toHaveBeenCalled();
        expect(wrapper.findAll('[data-test="dm-user"]')).toHaveLength(1);
        expect((wrapper.get('[data-test="dm-user-input"] input').element as HTMLInputElement).value).toBe('');
        expect(allowlist.dirty).toBe(true);
        expect(wrapper.find('[data-test="dm-unsaved"]').exists()).toBe(true);

        expect(await allowlist.save()).toBe(true);
        await flushPromises();

        expect(api.replaceBehaviorDmAllowlist).toHaveBeenCalledWith(7, { userIds: [B], groupNames: [] });
        expect(allowlist.dirty).toBe(false);
        expect(wrapper.findAll('[data-test="dm-user"]')).toHaveLength(1);
        expect(wrapper.find('[data-test="dm-unsaved"]').exists()).toBe(false);
    });

    it('the form’s cancel puts the saved list back, without writing', async () => {
        api.getBehaviorDmAllowlist.mockResolvedValue({ userIds: [A], groupNames: [] });
        const wrapper = mountSection();
        await expand(wrapper);

        await wrapper.get('[data-test="dm-user"] button').trigger('click');
        expect(wrapper.find('[data-test="dm-user"]').exists()).toBe(false);
        expect(allowlist.dirty).toBe(true);

        allowlist.discard();
        await flushPromises();

        expect(wrapper.findAll('[data-test="dm-user"]')).toHaveLength(1);
        expect(allowlist.dirty).toBe(false);
        expect(api.replaceBehaviorDmAllowlist).not.toHaveBeenCalled();
    });

    it('removing and adding the same entry back is not a change', async () => {
        api.getBehaviorDmAllowlist.mockResolvedValue({ userIds: [A, B], groupNames: [] });
        const wrapper = mountSection();
        await expand(wrapper);

        await wrapper.get('[data-test="dm-user"] button').trigger('click');
        await wrapper.get('[data-test="dm-user-input"] input').setValue(A);
        await wrapper.get('[data-test="dm-add-user"]').trigger('click');

        expect(allowlist.dirty).toBe(false);
        expect(await allowlist.save()).toBe(true);
        expect(api.replaceBehaviorDmAllowlist).not.toHaveBeenCalled();
    });

    it('a refused save says why and keeps the edits', async () => {
        api.replaceBehaviorDmAllowlist.mockRejectedValue(new Error('nope'));
        const wrapper = mountSection();
        await expand(wrapper);

        await wrapper.get('[data-test="dm-user-input"] input').setValue(B);
        await wrapper.get('[data-test="dm-add-user"]').trigger('click');
        expect(await allowlist.save()).toBe(false);
        await flushPromises();

        expect(wrapper.find('[role="alert"]').exists()).toBe(true);
        expect(wrapper.findAll('[data-test="dm-user"]')).toHaveLength(1);
        expect(allowlist.dirty).toBe(true);
    });

    it('a refresh keeps edits in progress', async () => {
        const wrapper = mountSection();
        await expand(wrapper);

        await wrapper.get('[data-test="dm-user-input"] input').setValue(B);
        await wrapper.get('[data-test="dm-add-user"]').trigger('click');
        await wrapper.get('[data-test="dm-refresh"]').trigger('click');
        await flushPromises();

        expect(wrapper.findAll('[data-test="dm-user"]')).toHaveLength(1);
        expect(allowlist.dirty).toBe(true);
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

    it('adding and removing a group edits the draft', async () => {
        api.getBehaviorDmAllowlist.mockResolvedValue({ userIds: [A], groupNames: [] });
        api.replaceBehaviorDmAllowlist.mockResolvedValueOnce({ userIds: [A], groupNames: ['ops'] });
        const wrapper = mountSection();
        await expand(wrapper);

        await chooseGroup(wrapper, 'ops');
        await wrapper.get('[data-test="dm-add-group"]').trigger('click');
        await flushPromises();
        expect(wrapper.findAll('[data-test="dm-group"]').map((c) => c.text())).toEqual(['ops']);
        expect(api.replaceBehaviorDmAllowlist).not.toHaveBeenCalled();

        await allowlist.save();
        expect(api.replaceBehaviorDmAllowlist).toHaveBeenLastCalledWith(7, { userIds: [A], groupNames: ['ops'] });

        await wrapper.get('[data-test="dm-group"] button').trigger('click');
        await flushPromises();
        expect(wrapper.find('[data-test="dm-group"]').exists()).toBe(false);
        expect(api.replaceBehaviorDmAllowlist).toHaveBeenCalledTimes(1);
        expect(allowlist.dirty).toBe(true);
    });

    it('offers the group targets not on the list yet', async () => {
        api.getBehaviorDmAllowlist.mockResolvedValue({ userIds: [], groupNames: ['ops'] });
        const wrapper = mountSection();
        await expand(wrapper);

        await wrapper.get('[data-test="dm-group-input"] button.select-trigger').trigger('click');
        await flushPromises();
        // the select's options, not the list's own chips
        const options = [...document.querySelectorAll<HTMLElement>('li:not(.chip)')].map((li) => li.textContent?.trim());
        expect(options).toContain('vip');
        expect(options).not.toContain('ops');
    });

    it('shows a listed group’s members read-only, with a way to the group’s own page', async () => {
        api.getBehaviorDmAllowlist.mockResolvedValue({ userIds: [], groupNames: ['ops'] });
        api.getGroupMembers.mockResolvedValue({ groupName: 'ops', members: [A] });
        const wrapper = mountSection();
        await expand(wrapper);

        expect(wrapper.find('.listed-group .chip').exists()).toBe(true);
        expect(wrapper.find('[data-test="add-member"]').exists()).toBe(false);
        expect(wrapper.find('.listed-group .chip-remove').exists()).toBe(false);

        openTarget.mockClear();
        await wrapper.get('[data-test="dm-edit-group"]').trigger('click');
        expect(openTarget).toHaveBeenCalledWith('group:ops');
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

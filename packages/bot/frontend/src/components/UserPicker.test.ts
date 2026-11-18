import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createI18n } from 'vue-i18n';
import { createPinia, setActivePinia } from 'pinia';

const api = vi.hoisted(() => ({
    fetchUserSummaries: vi.fn(),
    listChannels: vi.fn(),
    listGuilds: vi.fn(),
    listGuildMembers: vi.fn(),
}));
vi.mock('../api/discord', () => ({ fetchUserSummaries: api.fetchUserSummaries }));
vi.mock('../api/dm', () => ({ listChannels: api.listChannels }));
vi.mock('../api/guilds', () => ({ listGuilds: api.listGuilds, listGuildMembers: api.listGuildMembers }));

import { ApiError } from '../api/client';
import { useCurrentUserStore } from '../stores/currentUserStore';
import UserPicker from './UserPicker.vue';

/** i18n that answers with the key, so the tests assert on keys. */
const i18n = createI18n({ legacy: false, locale: 'en', missingWarn: false, fallbackWarn: false, messages: { en: {} } });

const ALICE = '111111111111111111';
const BOB = '222222222222222222';
const GUILD = '333333333333333333';

beforeAll(() => {
    // AppTabs and AppSelectField read matchMedia, which jsdom lacks
    window.matchMedia ??= ((query: string) => ({
        matches: false,
        media: query,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        addListener: () => undefined,
        removeListener: () => undefined,
        onchange: null,
        dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
});

const mounted: VueWrapper[] = [];
afterEach(() => {
    mounted.splice(0).forEach((w) => w.unmount());
    vi.useRealTimers();
});

beforeEach(() => {
    setActivePinia(createPinia());
    Object.values(api).forEach((fn) => fn.mockReset());
    api.fetchUserSummaries.mockResolvedValue({});
    api.listGuilds.mockResolvedValue([{ id: GUILD, name: 'My Guild' }]);
    api.listChannels.mockResolvedValue([
        { id: 'c1', recipient: { id: ALICE, username: 'alice', globalName: 'Alice', avatarUrl: null } },
        { id: 'c2', recipient: { id: BOB, username: 'bob', globalName: null, avatarUrl: null } },
    ]);
    api.listGuildMembers.mockResolvedValue([]);
});

function signInWith(...capabilities: string[]) {
    useCurrentUserStore().user = { userId: '999999999999999999', isOwner: false, capabilities } as never;
}

async function mountPicker(props: Record<string, unknown> = {}) {
    const wrapper = mount(UserPicker, {
        props: { modelValue: '', ...props },
        global: { plugins: [i18n] },
        attachTo: document.body,
    });
    mounted.push(wrapper);
    await flushPromises();
    return wrapper;
}

const tabLabels = (wrapper: VueWrapper) => wrapper.findAll('[role="tab"]').map((tab) => tab.text());

async function openSource(wrapper: VueWrapper, source: 'dm' | 'guild') {
    const tab = wrapper.findAll('[role="tab"]').find((t) => t.text() === `behaviors.userPicker.source.${source}`)!;
    await tab.trigger('click');
    await flushPromises();
}

const candidateNames = (wrapper: VueWrapper) => wrapper.findAll('[data-test="user-candidates"] .name').map((n) => n.text());

describe('UserPicker — by id', () => {
    it('is one text field when no list source is available', async () => {
        signInWith('behavior.manage');
        const wrapper = await mountPicker();
        expect(wrapper.find('[data-test="user-sources"]').exists()).toBe(false);
        await wrapper.find('input').setValue(ALICE);
        expect(wrapper.emitted('update:modelValue')).toEqual([[ALICE]]);
        // nothing to look the guild list up for
        expect(api.listGuilds).not.toHaveBeenCalled();
    });

    it('says whose id it is once the id is complete', async () => {
        api.fetchUserSummaries.mockResolvedValue({
            [ALICE]: { id: ALICE, username: 'alice', globalName: 'Alice', avatarUrl: '', bot: false },
        });
        const wrapper = await mountPicker({ modelValue: '1111' });
        expect(api.fetchUserSummaries).not.toHaveBeenCalled();
        expect(wrapper.find('[data-test="user-preview"]').exists()).toBe(false);

        await wrapper.setProps({ modelValue: ALICE });
        await flushPromises();
        expect(api.fetchUserSummaries).toHaveBeenCalledWith([ALICE]);
        expect(wrapper.find('[data-test="user-preview"]').text()).toContain('Alice');
    });

    it('takes an id nobody could be found for all the same', async () => {
        api.fetchUserSummaries.mockResolvedValue({ [BOB]: null });
        const wrapper = await mountPicker({ modelValue: BOB });
        expect(wrapper.find('[data-test="user-preview"]').exists()).toBe(false);
        expect((wrapper.find('input').element as HTMLInputElement).value).toBe(BOB);
    });

    it('a lookup that fails leaves the id as typed, with no preview', async () => {
        api.fetchUserSummaries.mockRejectedValue(new TypeError('network down'));
        const wrapper = await mountPicker({ modelValue: ALICE });
        expect(api.fetchUserSummaries).toHaveBeenCalledWith([ALICE]);
        expect(wrapper.find('[data-test="user-preview"]').exists()).toBe(false);
        expect((wrapper.find('input').element as HTMLInputElement).value).toBe(ALICE);
    });

    it('Enter in the id field submits', async () => {
        const wrapper = await mountPicker({ modelValue: ALICE });
        await wrapper.find('input').trigger('keydown', { key: 'Enter' });
        expect(wrapper.emitted('submit')).toHaveLength(1);
    });
});

describe('UserPicker — from the people who have DMed the bot', () => {
    it('is offered to an admin who may read the bot’s DMs, and loads when opened', async () => {
        signInWith('dm.message');
        const wrapper = await mountPicker();
        expect(tabLabels(wrapper)).toEqual(['behaviors.userPicker.source.id', 'behaviors.userPicker.source.dm']);
        expect(api.listChannels).not.toHaveBeenCalled();

        await openSource(wrapper, 'dm');
        expect(candidateNames(wrapper)).toEqual(['Alice', 'bob']);
    });

    it('filters by name as the admin types, and picks on click', async () => {
        signInWith('dm.message');
        const wrapper = await mountPicker();
        await openSource(wrapper, 'dm');
        await wrapper.find('[data-test="user-filter"] input').setValue('ali');
        expect(candidateNames(wrapper)).toEqual(['Alice']);

        await wrapper.find('[data-test="user-candidates"] button').trigger('click');
        expect(wrapper.emitted('update:modelValue')).toEqual([[ALICE]]);
    });

    it('goes away when the server refuses after all', async () => {
        signInWith('dm.message');
        api.listChannels.mockRejectedValue(new ApiError(403, 'forbidden'));
        const wrapper = await mountPicker();
        await openSource(wrapper, 'dm');
        expect(wrapper.find('[data-test="user-sources"]').exists()).toBe(false);
        expect(wrapper.find('[data-test="user-id"]').exists()).toBe(true);
    });
});

describe('UserPicker — from a server’s members', () => {
    it('is offered for the servers the admin may manage', async () => {
        signInWith(`guild:${GUILD}.manage`);
        const wrapper = await mountPicker();
        expect(tabLabels(wrapper)).toEqual(['behaviors.userPicker.source.id', 'behaviors.userPicker.source.guild']);
    });

    it('is not offered for a server the admin may only read messages in', async () => {
        signInWith(`guild:${GUILD}.message`);
        const wrapper = await mountPicker();
        expect(wrapper.find('[data-test="user-sources"]').exists()).toBe(false);
    });

    it('searches the only server at once, then by name as the admin types', async () => {
        signInWith('admin');
        api.listGuildMembers.mockResolvedValue([
            { id: ALICE, username: 'alice', globalName: 'Alice', nickname: 'Ali', avatarUrl: '', bot: false },
        ]);
        const wrapper = await mountPicker();
        await openSource(wrapper, 'guild');
        expect(api.listGuildMembers).toHaveBeenLastCalledWith(GUILD, { limit: 25, query: undefined });
        expect(candidateNames(wrapper)).toEqual(['Ali']);

        vi.useFakeTimers();
        await wrapper.find('[data-test="member-query"] input').setValue('al');
        expect(api.listGuildMembers).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(250);
        expect(api.listGuildMembers).toHaveBeenLastCalledWith(GUILD, { limit: 25, query: 'al' });

        await wrapper.find('[data-test="user-candidates"] button').trigger('click');
        expect(wrapper.emitted('update:modelValue')).toEqual([[ALICE]]);
    });

    it('says so when nobody matches', async () => {
        signInWith('admin');
        const wrapper = await mountPicker();
        await openSource(wrapper, 'guild');
        expect(wrapper.find('[data-test="user-empty"]').text()).toBe('behaviors.userPicker.empty');
    });
});

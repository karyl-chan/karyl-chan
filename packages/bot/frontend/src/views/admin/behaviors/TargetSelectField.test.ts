import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { computed, ref } from 'vue';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import type { BehaviorTargetView } from '../../../api/behavior';

const api = vi.hoisted(() => ({ createBehaviorTarget: vi.fn(), getBehaviorSchemas: vi.fn() }));
vi.mock('../../../api/behavior', () => api);
vi.mock('../../../api/guilds', () => ({ listGuilds: vi.fn(async () => []), listGuildTextChannels: vi.fn(async () => []) }));

import CreateTargetDialog from './CreateTargetDialog.vue';
import TargetSelectField from './TargetSelectField.vue';
import { BUILTIN_TARGETS, createdTarget, keyI18n, stubMatchMedia } from './behavior-test-support';
import { emptyDraft, type MessageTriggerDraft } from './message-trigger-draft';
import { TARGET_DIRECTORY, type TargetDirectory } from './target-directory';
import type { TargetNames } from './target-labels';

const i18n = keyI18n();
const GUILD = '123456789012345678';
const USER = '323456789012345678';

beforeAll(stubMatchMedia);

const mounted: VueWrapper[] = [];
afterEach(() => mounted.splice(0).forEach((w) => w.unmount()));

const names: TargetNames = {
    guilds: new Map([[GUILD, 'My Guild']]),
    channels: new Map(),
    user: (id) => (id === USER ? 'Alice' : null),
};

const listed = ref<BehaviorTargetView[]>([]);
const created = vi.fn<(target: BehaviorTargetView) => void>();

beforeEach(() => {
    setActivePinia(createPinia());
    listed.value = [...BUILTIN_TARGETS, createdTarget(`guild:${GUILD}`), createdTarget('group:vip'), createdTarget(`user:${USER}`)];
    created.mockReset().mockImplementation((target) => {
        listed.value = [...listed.value, target];
    });
});

function mountField(draft: MessageTriggerDraft = emptyDraft({ kind: 'bot_dm' }), props: Record<string, unknown> = {}) {
    const directory: TargetDirectory = {
        targets: computed(() => listed.value),
        names: computed(() => names),
        created,
    };
    const wrapper = mount(TargetSelectField, {
        props: { draft, ...props },
        global: { plugins: [i18n], provide: { [TARGET_DIRECTORY as symbol]: directory } },
        attachTo: document.body,
    });
    mounted.push(wrapper);
    return wrapper;
}

async function openOptions(wrapper: VueWrapper): Promise<HTMLElement[]> {
    await wrapper.find('button.select-trigger').trigger('click');
    await flushPromises();
    return [...document.querySelectorAll<HTMLElement>('li')];
}

async function choose(wrapper: VueWrapper, label: string) {
    const options = await openOptions(wrapper);
    options.find((li) => li.textContent?.trim() === label)!.click();
    await flushPromises();
}

const lastPatch = (wrapper: VueWrapper) => {
    const patches = wrapper.emitted('patch')!;
    return patches[patches.length - 1][0];
};

describe('TargetSelectField', () => {
    it('offers the listed targets by name, without App 指令, then "new target"', async () => {
        const options = await openOptions(mountField());
        expect(options.map((li) => li.textContent?.trim())).toEqual([
            'behaviors.target.botDm',
            'behaviors.target.guildAll',
            'My Guild',
            'vip',
            'Alice',
            'behaviors.targetField.new',
        ]);
    });

    it('shows the target the draft’s fields add up to', () => {
        const forUser = { ...emptyDraft({ kind: 'bot_dm' }), audienceKind: 'user' as const, audienceUserId: USER };
        expect(mountField(forUser).find('button.select-trigger').text()).toContain('Alice');
        expect(mountField(emptyDraft({ kind: 'guild', guildId: GUILD })).find('button.select-trigger').text()).toContain(
            'My Guild'
        );
    });

    it('choosing a target patches where the trigger is and for whom', async () => {
        const wrapper = mountField();
        await choose(wrapper, 'vip');
        expect(lastPatch(wrapper)).toMatchObject({ locationKind: 'bot_dm', audienceKind: 'group', audienceGroupName: 'vip' });

        await choose(wrapper, 'My Guild');
        expect(lastPatch(wrapper)).toMatchObject({ locationKind: 'guild', guildId: GUILD, audienceKind: 'all' });
    });

    it('offers only the targets the form may choose', async () => {
        const inBotDms = (target: BehaviorTargetView) => ['bot_dm', 'user', 'group'].includes(target.kind);
        const options = await openOptions(mountField(undefined, { allow: inBotDms }));
        expect(options.map((li) => li.textContent?.trim())).toEqual([
            'behaviors.target.botDm',
            'vip',
            'Alice',
            'behaviors.targetField.new',
        ]);
    });

    it('a target the list has not heard of still shows, as its key', () => {
        const elsewhere = emptyDraft({ kind: 'guild', guildId: '999999999999999999' });
        expect(mountField(elsewhere).find('button.select-trigger').text()).toContain('guild:999999999999999999');
    });

    it('shows the error for the fields it stands for', () => {
        const wrapper = mountField(undefined, { error: 'guildId must be a Discord id' });
        expect(wrapper.find('[data-test="target-error"]').text()).toBe('guildId must be a Discord id');
    });
});

describe('TargetSelectField — "new target"', () => {
    it('creates a target without leaving the form, lists it and chooses it', async () => {
        const wrapper = mountField();
        const dialog = () => wrapper.findComponent(CreateTargetDialog);
        expect(dialog().props('visible')).toBe(false);

        await choose(wrapper, 'behaviors.targetField.new');
        expect(dialog().props('visible')).toBe(true);
        // opening the dialog chooses nothing
        expect(wrapper.emitted('patch')).toBeUndefined();

        const family = createdTarget('group:family');
        dialog().vm.$emit('created', family);
        await flushPromises();
        expect(created).toHaveBeenCalledWith(family);
        expect(lastPatch(wrapper)).toMatchObject({ audienceKind: 'group', audienceGroupName: 'family' });
    });

    it('a new target of a kind the form cannot use is listed, not chosen', async () => {
        const inBotDms = (target: BehaviorTargetView) => ['bot_dm', 'user', 'group'].includes(target.kind);
        const wrapper = mountField(undefined, { allow: inBotDms });
        await choose(wrapper, 'behaviors.targetField.new');

        const server = createdTarget('guild:888888888888888888');
        wrapper.findComponent(CreateTargetDialog).vm.$emit('created', server);
        await flushPromises();
        expect(created).toHaveBeenCalledWith(server);
        expect(wrapper.emitted('patch')).toBeUndefined();
    });
});

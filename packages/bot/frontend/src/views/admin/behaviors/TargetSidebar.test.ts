import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import TargetSidebar from './TargetSidebar.vue';
import { BUILTIN_TARGETS, createdTarget, keyI18n } from './behavior-test-support';
import type { TargetNames } from './target-labels';

const i18n = keyI18n();
const GUILD = '123456789012345678';
const CHANNEL = '223456789012345678';
const USER = '323456789012345678';

const targets = [
    ...BUILTIN_TARGETS,
    createdTarget(`guild:${GUILD}`),
    createdTarget(`channel:${GUILD}:${CHANNEL}`),
    createdTarget('group:vip', { memberCount: 2 }),
    createdTarget(`user:${USER}`),
];

const names: TargetNames = {
    guilds: new Map([[GUILD, 'My Guild']]),
    channels: new Map(),
    user: (id) => (id === USER ? 'Alice' : null),
};

function mountSidebar(props: Record<string, unknown> = {}) {
    return mount(TargetSidebar, {
        props: { targets, counts: { bot_dm: 3, 'group:vip': 1 }, selected: 'bot_dm', names, ...props },
        global: { plugins: [i18n] },
    });
}

describe('TargetSidebar', () => {
    it('lists every target in one flat list, in the order given', () => {
        const wrapper = mountSidebar();
        expect(wrapper.findAll('.tab-row .name').map((n) => n.text())).toEqual([
            'behaviors.target.app',
            'behaviors.target.botDm',
            'behaviors.target.guildAll',
            'My Guild',
            'behaviors.target.channelIn',
            'vip',
            'Alice',
        ]);
        // nothing is nested under anything else
        expect(wrapper.findAll('ul')).toHaveLength(1);
    });

    it('shows an id for a name it could not resolve', () => {
        const wrapper = mountSidebar({ names: { guilds: new Map(), channels: new Map(), user: () => null } });
        const labels = wrapper.findAll('.tab-row .name').map((n) => n.text());
        expect(labels).toContain(GUILD);
        expect(labels).toContain(USER);
    });

    it('says what kind a created target is, and how many behaviors a target has', () => {
        const wrapper = mountSidebar();
        const row = (key: string) => wrapper.find(`[data-test="target-${key}"]`);
        expect(row(`guild:${GUILD}`).find('.sub').text()).toBe('behaviors.target.kind.guild');
        expect(row(`user:${USER}`).find('.sub').text()).toBe('behaviors.target.kind.user');
        expect(row('group:vip').find('.sub').text()).toBe('behaviors.sidebar.groupSub');
        expect(row('bot_dm').find('.count').text()).toBe('3');
        expect(row('group:vip').find('.count').text()).toBe('1');
        // a target with no behavior is listed all the same, without a count
        expect(row(`user:${USER}`).find('.count').exists()).toBe(false);
    });

    it('marks the selected target and selects another on click', async () => {
        const wrapper = mountSidebar();
        expect(wrapper.find('[data-test="target-bot_dm"]').attributes('aria-current')).toBe('page');
        await wrapper.find('[data-test="target-group:vip"]').trigger('click');
        expect(wrapper.emitted('select')).toEqual([['group:vip']]);
    });

    it('opens "new target" from the header', async () => {
        const wrapper = mountSidebar();
        await wrapper.find('[data-test="create-target"]').trigger('click');
        expect(wrapper.emitted('create')).toHaveLength(1);
    });
});

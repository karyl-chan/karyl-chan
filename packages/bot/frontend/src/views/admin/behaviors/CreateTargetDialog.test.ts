import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { ApiError } from '../../../api/client';

const api = vi.hoisted(() => ({ createBehaviorTarget: vi.fn(), getBehaviorSchemas: vi.fn() }));
vi.mock('../../../api/behavior', () => api);
// the user picker looks a typed id up to show whose it is
vi.mock('../../../api/discord', () => ({ fetchUserSummaries: vi.fn(async () => ({})) }));
vi.mock('../../../api/guilds', () => ({ listGuilds: vi.fn(async () => []), listGuildTextChannels: vi.fn(async () => []) }));

import CreateTargetDialog from './CreateTargetDialog.vue';
import { createdTarget, keyI18n, stubMatchMedia } from './behavior-test-support';

const i18n = keyI18n();
const GUILD = '123456789012345678';
const CHANNEL = '223456789012345678';
const USER = '323456789012345678';
const SNOWFLAKE = { type: 'string', pattern: '^\\d{17,20}$' };

/** The create schema GET /api/behaviors/schema serves. */
const TARGET_SCHEMA = {
    type: 'object',
    properties: {
        kind: { enum: ['guild', 'channel', 'user', 'group'] },
        guildId: SNOWFLAKE,
        channelId: SNOWFLAKE,
        userId: SNOWFLAKE,
        name: { type: 'string', minLength: 1, maxLength: 200, pattern: '\\S' },
    },
    required: ['kind'],
};

beforeAll(stubMatchMedia);

const mounted: VueWrapper[] = [];
afterEach(() => mounted.splice(0).forEach((w) => w.unmount()));

beforeEach(() => {
    setActivePinia(createPinia());
    api.createBehaviorTarget.mockReset();
    api.getBehaviorSchemas.mockReset().mockResolvedValue({ target: TARGET_SCHEMA });
});

function open() {
    const wrapper = mount(CreateTargetDialog, {
        props: { visible: true },
        global: { plugins: [i18n] },
        attachTo: document.body,
    });
    mounted.push(wrapper);
    return wrapper;
}

/** The dialog is teleported to <body>. */
const $ = (selector: string) => document.body.querySelector<HTMLElement>(selector);
const $$ = (selector: string) => [...document.body.querySelectorAll<HTMLElement>(selector)];

function field(label: string) {
    return $$('.app-field').find((f) => f.querySelector('.app-field__label')?.textContent === label)!;
}

async function type(label: string, value: string) {
    const input = field(label).querySelector('input')!;
    input.value = value;
    input.dispatchEvent(new Event('input'));
    await flushPromises();
}

/** Pick a kind in the kind select — the form's first select (its options are teleported). */
async function pickKind(kind: 'guild' | 'channel' | 'user' | 'group') {
    $('[data-test="create-target-form"] button.select-trigger')!.click();
    await flushPromises();
    const option = $$('li').find((li) => li.textContent?.trim() === `behaviors.target.create.kinds.${kind}`)!;
    option.click();
    await flushPromises();
}

async function submit() {
    $('[data-test="create-target-form"]')!.dispatchEvent(new Event('submit', { cancelable: true }));
    await flushPromises();
}

describe('CreateTargetDialog', () => {
    it('creates a server by its id when the guild list is not available', async () => {
        const target = createdTarget(`guild:${GUILD}`);
        api.createBehaviorTarget.mockResolvedValue({ target });
        const wrapper = open();
        await flushPromises();

        await type('behaviors.location.guildPicker', GUILD);
        await submit();

        expect(api.createBehaviorTarget).toHaveBeenCalledWith({ kind: 'guild', guildId: GUILD });
        expect(wrapper.emitted('created')).toEqual([[target]]);
        expect(wrapper.emitted('close')).toHaveLength(1);
    });

    it('creates a channel of a server', async () => {
        api.createBehaviorTarget.mockResolvedValue({ target: createdTarget(`channel:${GUILD}:${CHANNEL}`) });
        open();
        await flushPromises();
        await pickKind('channel');
        await type('behaviors.location.guildPicker', GUILD);
        await type('behaviors.location.channelPicker', CHANNEL);
        await submit();
        expect(api.createBehaviorTarget).toHaveBeenCalledWith({ kind: 'channel', guildId: GUILD, channelId: CHANNEL });
    });

    it('creates a user and a group', async () => {
        api.createBehaviorTarget.mockResolvedValue({ target: createdTarget(`user:${USER}`) });
        open();
        await flushPromises();
        await pickKind('user');
        await type('behaviors.target.create.userId', USER);
        await submit();
        expect(api.createBehaviorTarget).toHaveBeenLastCalledWith({ kind: 'user', userId: USER });

        await pickKind('group');
        await type('behaviors.target.create.groupName', '  vip  ');
        await submit();
        expect(api.createBehaviorTarget).toHaveBeenLastCalledWith({ kind: 'group', name: 'vip' });
    });

    it('checks the request against the server’s schema before sending it', async () => {
        const wrapper = open();
        await flushPromises();
        await pickKind('user');
        await type('behaviors.target.create.userId', 'nope');
        await submit();
        expect(api.createBehaviorTarget).not.toHaveBeenCalled();
        expect(field('behaviors.target.create.userId').querySelector('.app-field__error')).not.toBeNull();
        expect(wrapper.emitted('created')).toBeUndefined();
    });

    it('shows a name already in use on the name field, and stays open', async () => {
        api.createBehaviorTarget.mockRejectedValue(
            new ApiError(409, "a group named 'vip' already exists", 'name_conflict', 'name')
        );
        const wrapper = open();
        await flushPromises();
        await pickKind('group');
        await type('behaviors.target.create.groupName', 'vip');
        await submit();
        expect(field('behaviors.target.create.groupName').querySelector('.app-field__error')!.textContent).toContain(
            'already exists'
        );
        expect(wrapper.emitted('close')).toBeUndefined();
    });

    it('starts fresh each time it opens', async () => {
        const wrapper = open();
        await flushPromises();
        await pickKind('group');
        await type('behaviors.target.create.groupName', 'vip');
        await wrapper.setProps({ visible: false });
        await wrapper.setProps({ visible: true });
        await flushPromises();
        expect(field('behaviors.location.guildPicker')).toBeDefined();
        expect($$('.app-field__label').map((l) => l.textContent)).not.toContain('behaviors.target.create.groupName');
    });
});

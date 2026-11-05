/**
 * The System Behavior card (boards 3 and 4, #139): the login is pinned
 * and locked — only its trigger changes. Switching between a message
 * pattern and a command goes through a confirm that says the order (the
 * new trigger first) and then what each step did; a change within the
 * same kind saves directly. A message save needs a matching sample DM, a
 * command keeps guild install and bot DMs, and only an owner may edit.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import type { BehaviorItemView } from '../../../api/behavior';
import { ApiError } from '../../../api/client';

const api = vi.hoisted(() => ({
    switchLoginTrigger: vi.fn(),
    resyncBehaviorCommand: vi.fn(),
    getBehaviorSchemas: vi.fn(),
}));
vi.mock('../../../api/behavior', () => api);
vi.mock('../../../api/guilds', () => ({ listGuilds: vi.fn(async () => []), listGuildTextChannels: vi.fn(async () => []) }));

import SystemLoginCard from './SystemLoginCard.vue';
import { useCurrentUserStore } from '../../../stores/currentUserStore';
import { keyI18n, stubMatchMedia, systemLoginCommand, systemLoginMessage } from './behavior-test-support';

const i18n = keyI18n();
const mounted: VueWrapper[] = [];
afterEach(() => mounted.splice(0).forEach((w) => w.unmount()));

beforeAll(stubMatchMedia);

function signInAs(isOwner: boolean) {
    useCurrentUserStore().user = {
        userId: '111111111111111111',
        isOwner,
        role: isOwner ? 'owner' : 'admin',
        note: null,
        profile: null,
        capabilities: ['admin'],
    };
}

beforeEach(() => {
    setActivePinia(createPinia());
    signInAs(true);
    Object.values(api).forEach((fn) => fn.mockReset());
    api.getBehaviorSchemas.mockResolvedValue({});
});

async function mountOpen(system: BehaviorItemView = systemLoginMessage()): Promise<VueWrapper> {
    const wrapper = mount(SystemLoginCard, {
        props: { system, guildNames: new Map() },
        global: { plugins: [i18n] },
        attachTo: document.body,
    });
    mounted.push(wrapper);
    await wrapper.find('.app-item-card__expander').trigger('click');
    await flushPromises();
    return wrapper;
}

/** Pick a value in one of the card's AppSelectFields (its options are teleported). */
async function choose(wrapper: VueWrapper, label: string, option: string) {
    const field = wrapper.findAll('label.field').find((f) => f.find('.field-label').text() === label)!;
    await field.find('button.select-trigger').trigger('click');
    await flushPromises();
    const item = [...document.querySelectorAll<HTMLElement>('li')].find((li) => li.textContent?.trim() === option)!;
    item.click();
    await flushPromises();
}

async function save(wrapper: VueWrapper) {
    await wrapper.find('form[data-test="login-trigger-form"]').trigger('submit');
    await flushPromises();
}

const dialog = () => document.querySelector<HTMLElement>('[data-test="switch-dialog"]');
const steps = () => [...document.querySelectorAll<HTMLElement>('[data-test="switch-steps"] li')];
async function click(selector: string) {
    document.querySelector<HTMLElement>(selector)!.click();
    await flushPromises();
}

const registered = { status: 'registered', targets: [{ target: 'global', status: 'created' }] };

describe('SystemLoginCard — locked', () => {
    it('cannot be disabled or deleted, and its title is not editable', async () => {
        const wrapper = await mountOpen();
        expect(wrapper.find('[data-test="enabled-toggle"]').attributes('disabled')).toBeDefined();
        expect(wrapper.find('.more-btn').exists()).toBe(false);
        const title = wrapper.findAll('input').find((i) => (i.element as HTMLInputElement).value === '發送登入連結');
        expect(title?.attributes('readonly')).toBeDefined();
        expect(wrapper.find('[data-test="system-summary"]').text()).toBe('!login');
    });

    it('an admin who is not the owner sees it read-only, and why', async () => {
        signInAs(false);
        const wrapper = await mountOpen();
        expect(wrapper.find('[data-test="owner-only"]').text()).toBe('behaviors.system.ownerOnly');
        expect(wrapper.find('fieldset.trigger').attributes('disabled')).toBeDefined();
        expect(wrapper.find('[data-test="save-login-trigger"]').exists()).toBe(false);
        expect(wrapper.find('[data-test="resync"]').exists()).toBe(false);
    });

    it('shows a command login as its command', async () => {
        const wrapper = await mountOpen(systemLoginCommand());
        expect(wrapper.find('[data-test="system-summary"]').text()).toBe('/login');
        expect(wrapper.find('[data-test="login-name"] input').element).toHaveProperty('value', 'login');
    });
});

describe('SystemLoginCard — message → command (board 4)', () => {
    it('confirms first, then runs the switch and says what each step did', async () => {
        const after = systemLoginCommand();
        api.switchLoginTrigger.mockResolvedValue({ system: after, registration: registered });
        const wrapper = await mountOpen();
        await choose(wrapper, 'behaviors.system.triggerKind', 'behaviors.system.kindCommand');
        expect(wrapper.find('[data-test="switch-hint"]').text()).toContain('behaviors.system.switchToCommandHint');
        await save(wrapper);

        // nothing happens before the admin starts it
        expect(dialog()).not.toBeNull();
        expect(api.switchLoginTrigger).not.toHaveBeenCalled();
        expect(steps().map((s) => s.textContent)).toEqual([
            expect.stringContaining('behaviors.system.steps.register'),
            expect.stringContaining('behaviors.system.steps.confirm'),
            expect.stringContaining('behaviors.system.steps.disable'),
        ]);

        await click('[data-test="switch-start"]');
        expect(api.switchLoginTrigger).toHaveBeenCalledWith({
            kind: 'command',
            name: 'login',
            description: '取得 admin 後台一次性登入連結(僅授權使用者)',
            integrationTypes: ['guild_install'],
            contexts: ['BotDM'],
            ifUpdatedAt: '2026-10-27T00:00:00.000Z',
        });
        expect(steps().map((s) => s.dataset.tone)).toEqual(['ok', 'ok', 'ok']);
        expect(document.querySelector('[data-test="switch-done"]')).not.toBeNull();
        expect(dialog()!.querySelector('[data-test="registration-result"]')!.getAttribute('data-tone')).toBe('ok');

        // the page follows the login (it may move section) once the dialog closes
        expect(wrapper.emitted('updated')).toBeUndefined();
        await click('[data-test="switch-close"]');
        expect(wrapper.emitted('updated')).toEqual([[after]]);
    });

    it('a refusal from Discord changes nothing, and the dialog says so', async () => {
        api.switchLoginTrigger.mockRejectedValue(
            new ApiError(502, 'Discord did not accept /login: Missing Access', 'registration_failed', null, {
                targets: [{ target: 'global', status: 'failed', attempted: 'create', error: 'Missing Access' }],
            })
        );
        const wrapper = await mountOpen();
        await choose(wrapper, 'behaviors.system.triggerKind', 'behaviors.system.kindCommand');
        await save(wrapper);
        await click('[data-test="switch-start"]');

        expect(steps().map((s) => s.dataset.tone)).toEqual(['fail', 'skip', 'skip']);
        expect(document.querySelector('[data-test="switch-failed"]')).not.toBeNull();
        const result = dialog()!.querySelector('[data-test="registration-result"]')!;
        expect(result.getAttribute('data-tone')).toBe('danger');
        expect(result.textContent).toContain('Missing Access');

        await click('[data-test="switch-close"]');
        expect(wrapper.emitted('updated')).toBeUndefined();
        // the edit is still there to retry
        expect(wrapper.find('[data-test="switch-hint"]').exists()).toBe(true);
    });

    it('a refusal of a field closes the dialog and shows it on the field', async () => {
        api.switchLoginTrigger.mockRejectedValue(
            new ApiError(409, '/login is already taken by a command of plugin #7', 'name_conflict', 'name')
        );
        const wrapper = await mountOpen();
        await choose(wrapper, 'behaviors.system.triggerKind', 'behaviors.system.kindCommand');
        await save(wrapper);
        await click('[data-test="switch-start"]');
        expect(dialog()).toBeNull();
        expect(wrapper.find('[data-test="login-name"]').text()).toContain('already taken');
    });
});

describe('SystemLoginCard — the command keeps what the owner needs', () => {
    it('guild install and bot DMs stay ticked and cannot be unticked', async () => {
        const wrapper = await mountOpen(systemLoginCommand());
        const locked = (group: string, label: string) =>
            wrapper
                .find(`[data-test="${group}"]`)
                .findAll('label')
                .find((l) => l.text() === label)!
                .find('input');
        for (const [group, label] of [
            ['integration-types', 'behaviors.card.integration.guild_install'],
            ['contexts', 'behaviors.card.context.BotDM'],
        ]) {
            const box = locked(group, label);
            expect((box.element as HTMLInputElement).checked).toBe(true);
            expect(box.attributes('disabled')).toBeDefined();
        }
        expect(locked('contexts', 'behaviors.card.context.Guild').attributes('disabled')).toBeUndefined();
    });
});

describe('SystemLoginCard — command → message', () => {
    it('turns the pattern on first; a removal Discord has not made yet is a warning', async () => {
        api.switchLoginTrigger.mockResolvedValue({
            system: systemLoginMessage(),
            registration: { status: 'deferred', reason: '/login could not be removed from Discord yet' },
        });
        const wrapper = await mountOpen(systemLoginCommand());
        await choose(wrapper, 'behaviors.system.triggerKind', 'behaviors.system.kindMessage');
        await wrapper.find('[data-test="login-sample"] input').setValue('!login');
        await save(wrapper);
        expect(document.querySelector('[data-test="switch-sample"]')?.textContent).toContain('behaviors.system.switch.sampleNote');
        expect(steps().map((s) => s.textContent)).toEqual([
            expect.stringContaining('behaviors.system.steps.enable'),
            expect.stringContaining('behaviors.system.steps.remove'),
        ]);
        await click('[data-test="switch-start"]');
        expect(api.switchLoginTrigger).toHaveBeenCalledWith({
            kind: 'message',
            patternKind: 'startswith',
            patternValue: '!login',
            sample: '!login',
            ifUpdatedAt: '2026-10-27T00:00:00.000Z',
        });
        expect(steps().map((s) => s.dataset.tone)).toEqual(['ok', 'warn']);
        expect(steps()[1].textContent).toContain('could not be removed from Discord yet');
    });
});

describe('SystemLoginCard — same kind', () => {
    it('a new pattern needs a sample DM it matches before it can be saved', async () => {
        const wrapper = await mountOpen();
        await wrapper.find('[data-test="login-pattern"] input').setValue('!admin');
        expect(wrapper.find('[data-test="login-sample"]').text()).toContain('behaviors.system.sampleRequired');
        expect(wrapper.find('[data-test="save-login-trigger"]').attributes('disabled')).toBeDefined();
        await wrapper.find('[data-test="login-sample"] input').setValue('!Admin');
        expect(wrapper.find('[data-test="login-sample"]').text()).toContain('behaviors.system.sampleNoMatch');
        expect(wrapper.find('[data-test="save-login-trigger"]').attributes('disabled')).toBeDefined();
        await save(wrapper);
        expect(api.switchLoginTrigger).not.toHaveBeenCalled();
    });

    it('a new pattern with a matching sample saves without the switch dialog', async () => {
        const after = systemLoginMessage({ patternValue: '!admin' });
        api.switchLoginTrigger.mockResolvedValue({ system: after, registration: null });
        const wrapper = await mountOpen();
        await wrapper.find('[data-test="login-pattern"] input').setValue('!admin');
        await wrapper.find('[data-test="login-sample"] input').setValue('!admin');
        await save(wrapper);
        expect(dialog()).toBeNull();
        expect(api.switchLoginTrigger).toHaveBeenCalledWith({
            kind: 'message',
            patternKind: 'startswith',
            patternValue: '!admin',
            sample: '!admin',
            ifUpdatedAt: '2026-10-27T00:00:00.000Z',
        });
        expect(wrapper.emitted('updated')).toEqual([[after]]);
    });

    it("shows the server's refusal of a pattern on the pattern field", async () => {
        api.switchLoginTrigger.mockRejectedValue(
            new ApiError(400, 'Discord trims the spaces around a message', 'validation_failed', 'patternValue')
        );
        const wrapper = await mountOpen();
        await wrapper.find('[data-test="login-pattern"] input').setValue('!login ');
        await wrapper.find('[data-test="login-sample"] input').setValue('!login now');
        await save(wrapper);
        expect(wrapper.find('[data-test="login-pattern"]').text()).toContain('Discord trims');
    });

    it('a command login can be registered again as stored', async () => {
        api.resyncBehaviorCommand.mockResolvedValue({ command: systemLoginCommand(), registration: registered });
        const wrapper = await mountOpen(systemLoginCommand());
        await wrapper.find('[data-test="resync"]').trigger('click');
        await flushPromises();
        expect(api.resyncBehaviorCommand).toHaveBeenCalledWith(9);
        expect(wrapper.find('[data-test="registration-result"]').attributes('data-tone')).toBe('ok');
    });

    it('a message login has nothing to resync', async () => {
        const wrapper = await mountOpen();
        expect(wrapper.find('[data-test="resync"]').exists()).toBe(false);
    });
});

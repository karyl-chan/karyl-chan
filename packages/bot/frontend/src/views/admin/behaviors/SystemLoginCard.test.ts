/**
 * The System Behavior card (boards 3 and 4, #139, #172): the login is
 * pinned and locked — only its trigger changes. Switching between a
 * message pattern and a command starts from the kind tag in the title row
 * (the card body has no kind select), fills the new trigger in a dialog,
 * then confirms with the order (the new trigger first) and shows what each
 * step did; a change within the same kind saves directly. A message save
 * needs a matching sample DM, a command keeps guild install and bot DMs,
 * and only an owner may edit or switch.
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

/** Pick a kind on the title row's tag (its menu is teleported). */
async function pickKind(wrapper: VueWrapper, kind: 'message' | 'command') {
    await wrapper.find('[data-test="trigger-kind"]').trigger('click');
    await flushPromises();
    document.querySelector<HTMLElement>(`[data-test="convert-to-${kind}"]`)!.click();
    await flushPromises();
}

/** Type into an input of the (teleported) switch dialog. */
async function typeInDialog(field: string, value: string) {
    const input = dialog()!.querySelector<HTMLInputElement>(`[data-test="${field}"] input`)!;
    input.value = value;
    input.dispatchEvent(new Event('input'));
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

    it('has no kind select in the card body: the kind changes from the tag', async () => {
        const wrapper = await mountOpen();
        expect(wrapper.find('[data-test="login-kind"]').exists()).toBe(false);
        expect(wrapper.find('[data-test="trigger-kind"]').text()).toContain('behaviors.card.triggerMessage');
        await wrapper.find('[data-test="trigger-kind"]').trigger('click');
        await flushPromises();
        expect(document.querySelector('[data-test="convert-to-message"]')!.hasAttribute('disabled')).toBe(true);
        expect(document.querySelector('[data-test="convert-to-command"]')!.hasAttribute('disabled')).toBe(false);
    });

    it('an admin who is not the owner cannot switch the kind, and the tag says why', async () => {
        signInAs(false);
        const wrapper = await mountOpen();
        await wrapper.find('[data-test="trigger-kind"]').trigger('click');
        await flushPromises();
        const other = document.querySelector<HTMLElement>('[data-test="convert-to-command"]')!;
        expect(other.hasAttribute('disabled')).toBe(true);
        expect(other.querySelector('[data-test="convert-blocked"]')!.textContent).toBe('behaviors.system.ownerOnly');
        other.click();
        await flushPromises();
        expect(dialog()).toBeNull();
    });

    it('shows a command login as its command', async () => {
        const wrapper = await mountOpen(systemLoginCommand());
        expect(wrapper.find('[data-test="system-summary"]').text()).toBe('/login');
        expect(wrapper.find('[data-test="login-name"] input').element).toHaveProperty('value', 'login');
    });
});

describe('SystemLoginCard — message → command (board 4)', () => {
    it('fills the new command, confirms, then runs the switch and says what each step did', async () => {
        const after = systemLoginCommand();
        api.switchLoginTrigger.mockResolvedValue({ system: after, registration: registered });
        const wrapper = await mountOpen();
        await pickKind(wrapper, 'command');

        // the new trigger's fields first, with the login command's defaults
        expect(dialog()!.querySelector('[data-test="switch-fill"]')).not.toBeNull();
        expect(dialog()!.querySelector<HTMLInputElement>('[data-test="login-name"] input')!.value).toBe('login');
        await click('[data-test="switch-next"]');

        // nothing happens before the admin starts it
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
            description: '取得 admin 後台登入連結(僅授權使用者)',
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
        await pickKind(wrapper, 'command');
        await click('[data-test="switch-next"]');
        await click('[data-test="switch-start"]');

        expect(steps().map((s) => s.dataset.tone)).toEqual(['fail', 'skip', 'skip']);
        expect(document.querySelector('[data-test="switch-failed"]')).not.toBeNull();
        const result = dialog()!.querySelector('[data-test="registration-result"]')!;
        expect(result.getAttribute('data-tone')).toBe('danger');
        expect(result.textContent).toContain('Missing Access');

        await click('[data-test="switch-close"]');
        expect(wrapper.emitted('updated')).toBeUndefined();
        expect(wrapper.find('[data-test="system-summary"]').text()).toBe('!login');
    });

    it('a refusal of a field goes back to the field, in the dialog', async () => {
        api.switchLoginTrigger.mockRejectedValue(
            new ApiError(409, '/login is already taken by a command of plugin #7', 'name_conflict', 'name')
        );
        const wrapper = await mountOpen();
        await pickKind(wrapper, 'command');
        await click('[data-test="switch-next"]');
        await click('[data-test="switch-start"]');
        expect(dialog()!.querySelector('[data-test="switch-fill"]')).not.toBeNull();
        expect(dialog()!.querySelector('[data-test="login-name"]')!.textContent).toContain('already taken');
        expect(dialog()!.querySelector<HTMLButtonElement>('[data-test="switch-next"]')!.disabled).toBe(true);
        await typeInDialog('login-name', 'signin');
        expect(dialog()!.querySelector<HTMLButtonElement>('[data-test="switch-next"]')!.disabled).toBe(false);
    });

    it('a stale version closes the dialog and the card reloads', async () => {
        api.switchLoginTrigger.mockRejectedValue(new ApiError(409, 'changed by someone else', 'validation_failed', 'ifUpdatedAt'));
        const wrapper = await mountOpen();
        await pickKind(wrapper, 'command');
        await click('[data-test="switch-next"]');
        await click('[data-test="switch-start"]');
        expect(dialog()).toBeNull();
        expect(wrapper.emitted('reload')).toHaveLength(1);
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
    it('needs a sample DM; turns the pattern on first; a removal Discord has not made yet is a warning', async () => {
        api.switchLoginTrigger.mockResolvedValue({
            system: systemLoginMessage(),
            registration: { status: 'deferred', reason: '/login could not be removed from Discord yet' },
        });
        const wrapper = await mountOpen(systemLoginCommand());
        await pickKind(wrapper, 'message');
        expect(dialog()!.querySelector<HTMLInputElement>('[data-test="login-pattern"] input')!.value).toBe('!login');
        // the sample is what keeps the owner from locking themselves out
        expect(dialog()!.querySelector('[data-test="login-sample"]')!.textContent).toContain('behaviors.system.sampleRequired');
        expect(dialog()!.querySelector<HTMLButtonElement>('[data-test="switch-next"]')!.disabled).toBe(true);
        await typeInDialog('login-sample', '!login');
        await click('[data-test="switch-next"]');

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

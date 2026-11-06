/**
 * #172 — a command leaf converts to a message trigger from the command's
 * kind tag: pick the leaf (when there are several), where it matches and
 * its pattern; the dialog lists what the leaf loses before anything is
 * sent.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import type { CommandView } from '../../../api/behavior';
import { ApiError } from '../../../api/client';

const api = vi.hoisted(() => ({
    convertToMessage: vi.fn(),
    getBehaviorSchemas: vi.fn(),
}));
const toast = vi.hoisted(() => ({ show: vi.fn() }));
vi.mock('../../../api/behavior', () => api);
vi.mock('../../../api/guilds', () => ({ listGuilds: vi.fn(async () => []), listGuildTextChannels: vi.fn(async () => []) }));
vi.mock('@karyl-chan/ui', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@karyl-chan/ui')>()),
    useToastStore: () => toast,
}));

import CommandCard from './CommandCard.vue';
import {
    COMMAND_SCHEMA,
    CONVERT_TRIGGER_SCHEMA,
    keyI18n,
    savedCommand,
    savedLeaf,
    savedTrigger,
    stubMatchMedia,
} from './behavior-test-support';

const i18n = keyI18n();
const GUILD = '123456789012345678';

const mounted: VueWrapper[] = [];
afterEach(() => mounted.splice(0).forEach((w) => w.unmount()));

beforeAll(stubMatchMedia);

beforeEach(() => {
    setActivePinia(createPinia());
    Object.values(api).forEach((fn) => fn.mockReset());
    toast.show.mockReset();
    api.getBehaviorSchemas.mockResolvedValue({ command: COMMAND_SCHEMA, convertTrigger: CONVERT_TRIGGER_SCHEMA });
});

const $ = (selector: string) => document.body.querySelector<HTMLElement>(selector);
const losses = () => [...document.querySelectorAll<HTMLElement>('[data-test="convert-losses"] li')].map((li) => li.dataset.loss);

/** Opens the dialog from the tag of a collapsed card: the dialog does not need the card open. */
async function openConvert(command: CommandView = savedCommand()): Promise<VueWrapper> {
    const wrapper = mount(CommandCard, {
        props: { command, guildNames: new Map(), groupNames: [] },
        global: { plugins: [i18n] },
        attachTo: document.body,
    });
    mounted.push(wrapper);
    await wrapper.find('[data-test="trigger-kind"]').trigger('click');
    await flushPromises();
    expect($('[data-test="convert-to-command"]')!.hasAttribute('disabled')).toBe(true);
    $('[data-test="convert-to-message"]')!.click();
    await flushPromises();
    return wrapper;
}

async function typePattern(value: string) {
    const input = document.querySelector<HTMLInputElement>(
        '[data-test="convert-message-dialog"] input[placeholder="behaviors.trigger.patternPlaceholder"]'
    )!;
    input.value = value;
    input.dispatchEvent(new Event('input'));
    await flushPromises();
}

const submit = async () => {
    ($('[data-test="convert-submit"]') as HTMLButtonElement).click();
    await flushPromises();
};

describe('command → message', () => {
    it("the only leaf: starts in the command's section, warns the command goes, and converts", async () => {
        const trigger = savedTrigger({ id: 21, title: 'Status', patternValue: '!status' });
        api.convertToMessage.mockResolvedValue({ behavior: trigger, registration: { status: 'removed' } });
        const wrapper = await openConvert();
        expect(losses()).toEqual(['payloadToMessage', 'commandRemoved']);

        await submit();
        // no pattern yet: refused before sending
        expect(api.convertToMessage).not.toHaveBeenCalled();
        await typePattern('!status');
        await submit();
        expect(api.convertToMessage).toHaveBeenCalledWith(21, {
            location: 'bot_dm',
            patternKind: 'startswith',
            patternValue: '!status',
            stopOnMatch: false,
            audienceKind: 'all',
            audienceUserId: null,
            audienceGroupName: null,
            ifUpdatedAt: '2026-10-27T00:00:00.000Z',
        });
        expect(wrapper.emitted('converted')).toEqual([[trigger]]);
        // the command is gone with its card: the outcome is a toast
        expect(toast.show).toHaveBeenCalledWith(
            expect.stringContaining('behaviors.convertTrigger.toMessage.commandGone'),
            'success'
        );
    });

    it('several subcommands: pick the leaf; its options and the reply visibility are listed', async () => {
        const command = savedCommand({
            name: 'nas',
            section: `guild:${GUILD}`,
            registration: 'guild',
            guildId: GUILD,
            contexts: ['Guild'],
            leaves: [
                savedLeaf({ id: 30, subcommand: 'wake', title: 'Wake' }),
                savedLeaf({
                    id: 31,
                    subcommand: 'status',
                    title: 'Status',
                    options: [{ type: 'string', name: 'host', description: 'host', required: false }],
                }),
            ],
        });
        api.convertToMessage.mockResolvedValue({
            behavior: savedTrigger({ id: 31 }),
            registration: { status: 'registered', targets: [{ target: `guild:${GUILD}`, status: 'patched' }] },
        });
        const wrapper = await openConvert(command);
        // nothing picked yet: no losses to list, and converting asks for a leaf
        expect(losses()).toEqual([]);
        await typePattern('!nas');
        await submit();
        expect(api.convertToMessage).not.toHaveBeenCalled();
        expect($('[data-test="leaf-error"]')!.textContent).toBe('behaviors.validation.required');
        const leafField = [...document.querySelectorAll<HTMLElement>('[data-test="convert-message-dialog"] label.field')].find(
            (f) => f.querySelector('.field-label')?.textContent === 'behaviors.convertTrigger.toMessage.leaf'
        )!;
        expect(leafField).toBeDefined();

        // pick /nas status
        leafField.querySelector<HTMLElement>('button.select-trigger')!.click();
        await flushPromises();
        [...document.querySelectorAll<HTMLElement>('li')].find((li) => li.textContent?.includes('/nas status'))!.click();
        await flushPromises();
        expect(losses()).toEqual(['options', 'replyPublic', 'payloadToMessage', 'subcommandRemoved']);

        await submit();
        expect(api.convertToMessage).toHaveBeenCalledWith(31, expect.objectContaining({
            location: `guild:${GUILD}`,
            ignoreBots: true,
        }));
        expect(wrapper.emitted('converted')).toHaveLength(1);
        expect(toast.show).not.toHaveBeenCalled();
    });

    it('a refusal of a field shows on it; nothing is converted', async () => {
        api.convertToMessage.mockRejectedValue(
            new ApiError(400, 'the regex does not compile', 'validation_failed', 'patternValue')
        );
        const wrapper = await openConvert();
        await typePattern('!status');
        await submit();
        expect($('[data-test="convert-message-dialog"]')!.textContent).toContain('the regex does not compile');
        expect(wrapper.emitted('converted')).toBeUndefined();
    });
});

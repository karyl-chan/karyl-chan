/**
 * #31 — the approve-a-subset-of-what-the-manifest-asked-for machine.
 * PluginDetailSecurity held two structurally identical copies (RPC
 * scopes, global event subscriptions); both now run through this.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { effectScope, nextTick, ref } from 'vue';
import { APPROVAL_SAVED_FLASH_MS, selectionDiffers, useApprovalSet } from './use-approval-set';

function inScope<T>(fn: () => T): { value: T; stop: () => void } {
    const scope = effectScope();
    const value = scope.run(fn)!;
    return { value, stop: () => scope.stop() };
}

describe('selectionDiffers', () => {
    it('ignores order and duplicates, catches membership changes', () => {
        expect(selectionDiffers(['a', 'b'], ['b', 'a'])).toBe(false);
        expect(selectionDiffers([], [])).toBe(false);
        expect(selectionDiffers(['a'], ['a', 'b'])).toBe(true);
        expect(selectionDiffers(['a', 'b'], ['a'])).toBe(true);
        expect(selectionDiffers(['a'], ['b'])).toBe(true);
    });
});

describe('useApprovalSet', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    function setup(over: Partial<Parameters<typeof useApprovalSet>[0]> = {}) {
        const save = vi.fn().mockResolvedValue({ approved: ['a'] });
        return inScope(() =>
            useApprovalSet({
                requested: () => ['a', 'b', 'c'],
                approved: () => ['a'],
                save,
                ...over,
            }),
        );
    }

    it('starts with the checkboxes matching what is already approved', () => {
        const { value: s } = setup();
        expect(s.checked.value).toEqual(['a']);
        expect(s.approved.value).toEqual(['a']);
        expect(s.dirty.value).toBe(false);
        expect(s.pendingCount.value).toBe(2);
        expect(s.isApproved('a')).toBe(true);
        expect(s.isApproved('b')).toBe(false);
    });

    it('tracks the requested list reactively', () => {
        const requested = ref(['a']);
        const { value: s } = inScope(() =>
            useApprovalSet({
                requested: () => requested.value,
                approved: () => [],
                save: vi.fn(),
            }),
        );
        expect(s.pendingCount.value).toBe(1);
        requested.value = ['a', 'b'];
        expect(s.pendingCount.value).toBe(2);
    });

    it('approveAll checks everything requested without approving it yet', () => {
        const { value: s } = setup();
        s.approveAll();
        expect(s.checked.value).toEqual(['a', 'b', 'c']);
        expect(s.dirty.value).toBe(true);
        // Nothing is granted until the save round-trips.
        expect(s.approved.value).toEqual(['a']);
        expect(s.pendingCount.value).toBe(2);
    });

    it('adopts the server’s clamped answer rather than the local checkboxes', async () => {
        // The bot clamps the request to what the manifest actually asks for,
        // so the response — not `checked` — is the new truth.
        const save = vi.fn().mockResolvedValue({ approved: ['a', 'b'] });
        const { value: s } = setup({ save });
        s.checked.value = ['a', 'b', 'zzz-not-requested'];

        expect(await s.save()).toBe(true);

        expect(save).toHaveBeenCalledWith(['a', 'b', 'zzz-not-requested']);
        expect(s.approved.value).toEqual(['a', 'b']);
        expect(s.checked.value).toEqual(['a', 'b']);
        expect(s.dirty.value).toBe(false);
        expect(s.pendingCount.value).toBe(1);
    });

    it('refuses to save when nothing changed, or while a save is in flight', async () => {
        let release!: (v: { approved: string[] }) => void;
        const save = vi.fn().mockImplementation(() => new Promise((r) => { release = r; }));
        const { value: s } = setup({ save });

        expect(await s.save()).toBe(false);
        expect(save).not.toHaveBeenCalled();

        s.checked.value = ['a', 'b'];
        const first = s.save();
        await nextTick();
        expect(s.saving.value).toBe(true);
        expect(await s.save()).toBe(false);
        expect(save).toHaveBeenCalledTimes(1);

        release({ approved: ['a', 'b'] });
        await first;
        expect(s.saving.value).toBe(false);
    });

    it('flashes saved for APPROVAL_SAVED_FLASH_MS', async () => {
        const { value: s } = setup();
        s.checked.value = ['a', 'b'];
        await s.save();
        expect(s.saved.value).toBe(true);
        vi.advanceTimersByTime(APPROVAL_SAVED_FLASH_MS - 1);
        expect(s.saved.value).toBe(true);
        vi.advanceTimersByTime(1);
        expect(s.saved.value).toBe(false);
    });

    it('reports a failure and leaves the approved set untouched', async () => {
        const save = vi.fn().mockRejectedValue(new Error('403 nope'));
        const { value: s } = setup({ save });
        s.checked.value = ['a', 'b'];

        expect(await s.save()).toBe(false);

        expect(s.error.value).toBe('403 nope');
        expect(s.approved.value).toEqual(['a']);
        expect(s.checked.value).toEqual(['a', 'b']);
        expect(s.saved.value).toBe(false);
    });

    it('drops the flash timer when its scope is disposed', async () => {
        const { value: s, stop } = setup();
        s.checked.value = ['a', 'b'];
        await s.save();
        stop();
        expect(vi.getTimerCount()).toBe(0);
    });
});

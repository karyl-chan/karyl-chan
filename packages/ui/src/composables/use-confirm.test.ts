import { describe, it, expect, afterEach } from 'vitest';
import { useConfirm } from './use-confirm';

afterEach(() => {
    useConfirm().handleClose();
});

describe('useConfirm', () => {
    it('resolves true on confirm and false on close', async () => {
        const { confirm, handleConfirm, handleClose } = useConfirm();
        const a = confirm({ title: 'A', message: 'a' });
        handleConfirm();
        await expect(a).resolves.toBe(true);

        const b = confirm({ title: 'B', message: 'b' });
        handleClose();
        await expect(b).resolves.toBe(false);
    });

    it('resolves a superseded pending confirm with false', async () => {
        const { confirm, pending, handleConfirm } = useConfirm();
        const first = confirm({ title: 'First', message: '1' });
        const second = confirm({ title: 'Second', message: '2' });

        await expect(first).resolves.toBe(false);
        expect(pending.value?.options.title).toBe('Second');

        handleConfirm();
        await expect(second).resolves.toBe(true);
        expect(pending.value).toBeNull();
    });
});

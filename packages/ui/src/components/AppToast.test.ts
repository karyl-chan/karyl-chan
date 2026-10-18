import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { nextTick } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import { mount, type VueWrapper } from '@vue/test-utils';
import AppToast from './AppToast.vue';
import { useToastStore, DEFAULT_TOAST_DURATION } from '../stores/toastStore';

let wrapper: VueWrapper | null = null;

beforeEach(() => {
    setActivePinia(createPinia());
    vi.useFakeTimers();
});
afterEach(() => {
    wrapper?.unmount();
    wrapper = null;
    vi.useRealTimers();
    document.body.innerHTML = '';
});

describe('useToastStore', () => {
    it('keeps the legacy show(message, type?) signature and defaults', () => {
        const store = useToastStore();
        store.show('boom');
        expect(store.items[0]).toMatchObject({ message: 'boom', type: 'error', duration: DEFAULT_TOAST_DURATION });

        vi.advanceTimersByTime(DEFAULT_TOAST_DURATION - 1);
        expect(store.items).toHaveLength(1);
        vi.advanceTimersByTime(1);
        expect(store.items).toHaveLength(0);
    });

    it('accepts success/warn types and a custom duration', () => {
        const store = useToastStore();
        store.show('saved', 'success', { duration: 1000 });
        store.show('careful', 'warn');
        expect(store.items.map((t) => t.type)).toEqual(['success', 'warn']);

        vi.advanceTimersByTime(1000);
        expect(store.items.map((t) => t.message)).toEqual(['careful']);
    });

    it('duration 0 is sticky until dismissed; show() returns the id', () => {
        const store = useToastStore();
        const id = store.show('stays', 'info', { duration: 0 });
        vi.advanceTimersByTime(60_000);
        expect(store.items).toHaveLength(1);
        store.dismiss(id);
        expect(store.items).toHaveLength(0);
    });
});

describe('AppToast', () => {
    async function render() {
        wrapper = mount(AppToast, { attachTo: document.body });
        await nextTick();
    }
    const items = () => Array.from(document.querySelectorAll<HTMLElement>('.toast-item'));

    it('uses role=alert for error/warn and polite role=status for info/success', async () => {
        await render();
        const store = useToastStore();
        store.show('e', 'error');
        store.show('w', 'warn');
        store.show('i', 'info');
        store.show('s', 'success');
        await nextTick();

        const [e, w, i, s] = items();
        expect(e.getAttribute('role')).toBe('alert');
        expect(w.getAttribute('role')).toBe('alert');
        expect(i.getAttribute('role')).toBe('status');
        expect(i.getAttribute('aria-live')).toBe('polite');
        expect(s.getAttribute('role')).toBe('status');
        expect(s.classList.contains('toast-item--success')).toBe(true);
        expect(w.classList.contains('toast-item--warn')).toBe(true);
    });

    it('renders a close button only for sticky toasts and ignores body clicks on them', async () => {
        await render();
        const store = useToastStore();
        store.show('timed', 'info');
        store.show('sticky', 'warn', { duration: 0 });
        await nextTick();

        const [timed, sticky] = items();
        expect(timed.querySelector('.toast-close')).toBeNull();
        const close = sticky.querySelector<HTMLButtonElement>('.toast-close');
        expect(close?.getAttribute('aria-label')).toBe('Dismiss');

        sticky.click();
        await nextTick();
        expect(store.items.map((t) => t.message)).toContain('sticky');

        close!.click();
        await nextTick();
        expect(store.items.map((t) => t.message)).not.toContain('sticky');
    });
});

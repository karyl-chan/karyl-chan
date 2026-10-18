import { describe, it, expect, afterEach } from 'vitest';
import { defineComponent, h, nextTick, ref } from 'vue';
import { mount, type VueWrapper } from '@vue/test-utils';
import AppModal from './AppModal.vue';

const wrappers: VueWrapper[] = [];
afterEach(() => {
    wrappers.splice(0).forEach((w) => w.unmount());
    document.body.innerHTML = '';
    document.body.removeAttribute('style');
});

function track<T extends VueWrapper>(w: T): T {
    wrappers.push(w);
    return w;
}

function pressEscape() {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
}

function panels(): HTMLElement[] {
    return Array.from(document.querySelectorAll<HTMLElement>('.app-modal-panel'));
}

describe('AppModal', () => {
    it('Escape closes only the topmost of two stacked modals', async () => {
        const closes: string[] = [];
        const Host = defineComponent({
            setup() {
                const a = ref(false);
                const b = ref(false);
                return { a, b };
            },
            render() {
                return h('div', [
                    h(AppModal, { visible: this.a, title: 'A', onClose: () => { closes.push('A'); this.a = false; } }),
                    h(AppModal, { visible: this.b, title: 'B', onClose: () => { closes.push('B'); this.b = false; } })
                ]);
            }
        });
        const w = track(mount(Host, { attachTo: document.body }));
        const vm = w.vm as unknown as { a: boolean; b: boolean };
        vm.a = true;
        await nextTick();
        vm.b = true;
        await nextTick();

        pressEscape();
        await nextTick();
        expect(closes).toEqual(['B']);
        pressEscape();
        await nextTick();
        expect(closes).toEqual(['B', 'A']);
    });

    it('closeOnEscape=false swallows Escape instead of closing', async () => {
        const w = track(mount(AppModal, { attachTo: document.body, props: { visible: true, title: 'T', closeOnEscape: false } }));
        await nextTick();
        pressEscape();
        expect(w.emitted('close')).toBeUndefined();
    });

    it('closes on backdrop only when the press starts and ends on the backdrop', async () => {
        const w = track(mount(AppModal, { attachTo: document.body, props: { visible: true, title: 'T' } }));
        await nextTick();
        const backdrop = document.querySelector<HTMLElement>('.app-modal-backdrop')!;
        const panel = panels()[0];

        // Drag that starts inside the panel and is released over the backdrop.
        panel.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
        backdrop.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        expect(w.emitted('close')).toBeUndefined();

        backdrop.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
        backdrop.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        expect(w.emitted('close')).toHaveLength(1);
    });

    it('labels the dialog by title, else by ariaLabel, and localizes the close button', async () => {
        const titled = track(mount(AppModal, {
            attachTo: document.body,
            props: { visible: true, title: 'Settings', closeLabel: '關閉' }
        }));
        await nextTick();
        let panel = panels()[0];
        const labelledBy = panel.getAttribute('aria-labelledby');
        expect(labelledBy).toBeTruthy();
        expect(document.getElementById(labelledBy!)?.textContent).toContain('Settings');
        expect(panel.hasAttribute('aria-label')).toBe(false);
        expect(panel.querySelector('.app-modal-close')?.getAttribute('aria-label')).toBe('關閉');
        titled.unmount();
        wrappers.splice(wrappers.indexOf(titled), 1);

        track(mount(AppModal, { attachTo: document.body, props: { visible: true, ariaLabel: 'Image preview' } }));
        await nextTick();
        panel = panels()[0];
        expect(panel.getAttribute('aria-label')).toBe('Image preview');
        expect(panel.hasAttribute('aria-labelledby')).toBe(false);
    });

    it('moves focus in, traps Tab, and restores focus on close', async () => {
        const opener = document.createElement('button');
        document.body.appendChild(opener);
        opener.focus();

        const w = track(mount(AppModal, {
            attachTo: document.body,
            props: { visible: false, title: 'Form' },
            slots: {
                default: () => [
                    h('input', { class: 'first' }),
                    h('button', { class: 'last' }, 'Save')
                ]
            }
        }));
        await w.setProps({ visible: true });
        await nextTick();
        await nextTick();

        const panel = panels()[0];
        const first = panel.querySelector<HTMLElement>('.first')!;
        const last = panel.querySelector<HTMLElement>('.last')!;
        const closeBtn = panel.querySelector<HTMLElement>('.app-modal-close')!;
        expect(document.activeElement).toBe(first);

        // Tab from the last control wraps to the first tabbable (close button).
        last.focus();
        last.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
        expect(document.activeElement).toBe(closeBtn);

        // Shift+Tab from the first tabbable wraps to the last.
        closeBtn.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }));
        expect(document.activeElement).toBe(last);

        await w.setProps({ visible: false });
        await nextTick();
        expect(document.activeElement).toBe(opener);
    });

    it('focuses the panel itself when there is nothing focusable', async () => {
        track(mount(AppModal, {
            attachTo: document.body,
            props: { visible: true, ariaLabel: 'Notice' },
            slots: { default: () => h('p', 'Read only') }
        }));
        await nextTick();
        await nextTick();
        expect(document.activeElement).toBe(panels()[0]);
    });

    it('ref-counts the body scroll lock across stacked modals', async () => {
        document.body.style.overflow = 'auto';
        const a = track(mount(AppModal, { attachTo: document.body, props: { visible: true, title: 'A' } }));
        const b = track(mount(AppModal, { attachTo: document.body, props: { visible: true, title: 'B' } }));
        await nextTick();
        expect(document.body.style.overflow).toBe('hidden');

        await b.setProps({ visible: false });
        expect(document.body.style.overflow).toBe('hidden');

        await a.setProps({ visible: false });
        expect(document.body.style.overflow).toBe('auto');
    });
});

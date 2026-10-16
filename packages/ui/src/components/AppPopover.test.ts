import { describe, it, expect, afterEach } from 'vitest';
import { defineComponent, h, nextTick, ref } from 'vue';
import { mount, type VueWrapper } from '@vue/test-utils';
import AppPopover from './AppPopover.vue';
import AppSelect from './AppSelect.vue';
import { createVirtualElement } from '../composables/use-popover';

const wrappers: VueWrapper[] = [];
afterEach(() => {
    wrappers.splice(0).forEach((w) => w.unmount());
    document.body.innerHTML = '';
});

function mountTracked<T>(...args: Parameters<typeof mount>) {
    const w = mount(...args);
    wrappers.push(w);
    return w as unknown as VueWrapper<T & InstanceType<typeof AppPopover>>;
}

function content(text: string): HTMLElement {
    const el = Array.from(document.querySelectorAll<HTMLElement>('.app-popover-content'))
        .find((c) => c.textContent?.includes(text));
    if (!el) throw new Error(`popover content "${text}" not found`);
    return el;
}

describe('AppPopover', () => {
    it('opens on trigger click when v-model:open is not bound (uncontrolled)', async () => {
        const w = mountTracked(AppPopover, {
            attachTo: document.body,
            slots: {
                trigger: () => h('button', { class: 'trig' }, 'Open'),
                default: () => h('p', 'uncontrolled body')
            }
        });
        await nextTick();
        expect(content('uncontrolled body').hasAttribute('data-show')).toBe(false);

        await w.find('.trig').trigger('click');
        await nextTick();
        expect(content('uncontrolled body').hasAttribute('data-show')).toBe(true);
        expect(w.emitted('update:open')?.[0]).toEqual([true]);
    });

    it('still honours a bound v-model:open (controlled)', async () => {
        const Host = defineComponent({
            setup() {
                const open = ref(false);
                return () => h(AppPopover, {
                    open: open.value,
                    'onUpdate:open': (v: boolean) => { open.value = v; }
                }, {
                    trigger: () => h('button', { class: 'trig' }, 'Open'),
                    default: () => h('p', 'controlled body')
                });
            }
        });
        const w = mountTracked(Host, { attachTo: document.body });
        await nextTick();
        expect(content('controlled body').hasAttribute('data-show')).toBe(false);
        await w.find('.trig').trigger('click');
        await nextTick();
        expect(content('controlled body').hasAttribute('data-show')).toBe(true);
    });

    it('AppSelect opens uncontrolled too', async () => {
        const w = mountTracked(AppSelect, {
            attachTo: document.body,
            slots: {
                trigger: () => h('button', { class: 'trig' }, 'Pick'),
                default: () => h('p', 'select body')
            }
        });
        await nextTick();
        await w.find('.trig').trigger('click');
        await nextTick();
        expect(content('select body').hasAttribute('data-show')).toBe(true);
    });

    it('accepts a VirtualElement as referenceEl and closes on outside click', async () => {
        const Host = defineComponent({
            setup() {
                const open = ref(true);
                const anchor = ref(createVirtualElement(40, 60));
                return { open, anchor };
            },
            render() {
                return h(AppPopover, {
                    referenceEl: this.anchor,
                    open: this.open,
                    'onUpdate:open': (v: boolean) => { this.open = v; }
                }, { default: () => h('p', 'virtual body') });
            }
        });
        const w = mountTracked<{ open: boolean; anchor: ReturnType<typeof createVirtualElement> }>(
            Host, { attachTo: document.body }
        );
        await nextTick();
        expect(content('virtual body').hasAttribute('data-show')).toBe(true);
        // No trigger wrapper is rendered for an external anchor.
        expect(document.querySelector('.app-popover-trigger')).toBeNull();

        // Swapping the anchor while open must not throw.
        (w.vm as unknown as { anchor: unknown }).anchor = createVirtualElement(10, 10, document.body);
        await nextTick();
        await nextTick();

        // Let the show-click guard (setTimeout 0) lapse, then click outside.
        await new Promise((r) => setTimeout(r, 0));
        const outside = document.createElement('div');
        document.body.appendChild(outside);
        outside.click();
        await nextTick();
        expect((w.vm as unknown as { open: boolean }).open).toBe(false);
    });
});

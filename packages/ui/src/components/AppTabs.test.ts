import { describe, it, expect, afterEach } from 'vitest';
import { defineComponent, h, nextTick, ref } from 'vue';
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils';
import { createRouter, createMemoryHistory } from 'vue-router';
import AppTabs from './AppTabs.vue';
import AppTabsRouted from './AppTabsRouted.vue';
import { nextTabKey, rovingTabKey } from './tab-keyboard';
import type { TabDef } from './tab-types';

const TABS: TabDef[] = [
    { key: 'a', label: 'Alpha' },
    { key: 'b', label: 'Beta', disabled: true },
    { key: 'c', label: 'Gamma' },
    { key: 'd', label: 'Delta' }
];

const wrappers: VueWrapper[] = [];
afterEach(() => {
    wrappers.splice(0).forEach((w) => w.unmount());
    document.body.innerHTML = '';
});

function press(el: Element, key: string) {
    el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
}

describe('tab-keyboard', () => {
    it('skips disabled tabs and wraps', () => {
        expect(nextTabKey(TABS, 'a', 'ArrowRight')).toBe('c');
        expect(nextTabKey(TABS, 'c', 'ArrowLeft')).toBe('a');
        expect(nextTabKey(TABS, 'd', 'ArrowRight')).toBe('a');
        expect(nextTabKey(TABS, 'a', 'ArrowLeft')).toBe('d');
        expect(nextTabKey(TABS, 'c', 'Home')).toBe('a');
        expect(nextTabKey(TABS, 'a', 'End')).toBe('d');
        expect(nextTabKey(TABS, 'a', 'ArrowDown')).toBeNull();
        expect(nextTabKey(TABS, 'a', 'ArrowDown', 'vertical')).toBe('c');
        expect(nextTabKey(TABS, 'a', 'Enter')).toBeNull();
    });

    it('puts the selected (or first enabled) tab in the Tab sequence', () => {
        expect(rovingTabKey(TABS, 'c')).toBe('c');
        expect(rovingTabKey(TABS, 'b')).toBe('a');
        expect(rovingTabKey(TABS, undefined)).toBe('a');
    });
});

describe('AppTabs', () => {
    function mountTabs() {
        const Host = defineComponent({
            setup() {
                const tab = ref('a');
                return { tab };
            },
            render() {
                return h(AppTabs, {
                    tabs: TABS,
                    modelValue: this.tab,
                    'onUpdate:modelValue': (v: string) => { this.tab = v; }
                }, { default: () => h('p', `panel ${this.tab}`) });
            }
        });
        const w = mount(Host, { attachTo: document.body });
        wrappers.push(w);
        return w;
    }
    const tabEls = () => Array.from(document.querySelectorAll<HTMLElement>('.primary-row [role="tab"]'));

    it('uses a roving tabindex and wires tabs to the tabpanel', async () => {
        mountTabs();
        await nextTick();
        const [a, b, c, d] = tabEls();
        expect([a, b, c, d].map((t) => t.getAttribute('tabindex'))).toEqual(['0', '-1', '-1', '-1']);

        const panel = document.querySelector<HTMLElement>('[role="tabpanel"]')!;
        expect(panel.id).toBeTruthy();
        expect(a.getAttribute('aria-controls')).toBe(panel.id);
        expect(a.id).toBeTruthy();
        expect(panel.getAttribute('aria-labelledby')).toBe(a.id);
    });

    it('ArrowRight / ArrowLeft / Home / End move focus and selection, skipping disabled tabs', async () => {
        const w = mountTabs();
        await nextTick();
        const vm = w.vm as unknown as { tab: string };
        let [a] = tabEls();
        a.focus();

        press(a, 'ArrowRight');
        await nextTick();
        expect(vm.tab).toBe('c');
        let [, , c, d] = tabEls();
        expect(document.activeElement).toBe(c);
        expect(c.getAttribute('tabindex')).toBe('0');
        expect(document.querySelector('[role="tabpanel"]')!.getAttribute('aria-labelledby')).toBe(c.id);

        press(c, 'End');
        await nextTick();
        expect(vm.tab).toBe('d');
        [, , , d] = tabEls();
        expect(document.activeElement).toBe(d);

        press(d, 'ArrowRight');
        await nextTick();
        expect(vm.tab).toBe('a');

        [a] = tabEls();
        press(a, 'ArrowLeft');
        await nextTick();
        expect(vm.tab).toBe('d');

        [, , c, d] = tabEls();
        press(d, 'Home');
        await nextTick();
        expect(vm.tab).toBe('a');
    });
});

describe('AppTabsRouted', () => {
    it('shares the keyboard model and syncs the URL with replace', async () => {
        const router = createRouter({
            history: createMemoryHistory(),
            routes: [{ path: '/', component: { render: () => null } }]
        });
        await router.push('/');
        await router.isReady();

        const Host = defineComponent({
            setup() {
                const tab = ref('a');
                return { tab };
            },
            render() {
                return h(AppTabsRouted, {
                    tabs: TABS,
                    modelValue: this.tab,
                    'onUpdate:modelValue': (v: string) => { this.tab = v; }
                }, { default: () => h('p', 'routed panel') });
            }
        });
        const w = mount(Host, { attachTo: document.body, global: { plugins: [router] } });
        wrappers.push(w);
        await flushPromises();

        const tabs = Array.from(document.querySelectorAll<HTMLElement>('.primary-row [role="tab"]'));
        expect(tabs.map((t) => t.getAttribute('tabindex'))).toEqual(['0', '-1', '-1', '-1']);
        const panel = document.querySelector<HTMLElement>('[role="tabpanel"]')!;
        expect(tabs[0].getAttribute('aria-controls')).toBe(panel.id);

        tabs[0].focus();
        press(tabs[0], 'ArrowRight');
        await flushPromises();
        expect(router.currentRoute.value.query.tab).toBe('c');
        expect((w.vm as unknown as { tab: string }).tab).toBe('c');
        expect(document.activeElement?.getAttribute('data-tab-key')).toBe('c');
    });
});

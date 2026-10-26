import { computed, inject, onBeforeUnmount, provide, ref, watch, type InjectionKey, type Ref } from 'vue';

/**
 * Which behavior forms hold unsaved edits (#105), so the page can warn
 * before switching section or leaving — either would drop the drafts.
 */
interface UnsavedDraftRegistry {
    mark(key: string, dirty: boolean): void;
}

const KEY: InjectionKey<UnsavedDraftRegistry> = Symbol('unsaved-behavior-drafts');

export function provideUnsavedDrafts() {
    const keys = ref(new Set<string>());
    provide(KEY, {
        mark(key, dirty) {
            const next = new Set(keys.value);
            if (dirty) next.add(key);
            else next.delete(key);
            keys.value = next;
        },
    });
    return { hasUnsaved: computed(() => keys.value.size > 0) };
}

/**
 * Report a form's draft state for as long as the form is mounted. `key`
 * names the form across the page — `behavior:<id>` for a message trigger
 * or a command leaf, `command:<id>` for a command — since behavior and
 * command ids come from different tables.
 */
export function trackUnsavedDraft(key: string, dirty: Ref<boolean>): void {
    const registry = inject(KEY, null);
    if (!registry) return;
    watch(dirty, (value) => registry.mark(key, value), { immediate: true });
    onBeforeUnmount(() => registry.mark(key, false));
}

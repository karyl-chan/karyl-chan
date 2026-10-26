import { computed, inject, onBeforeUnmount, provide, ref, watch, type InjectionKey, type Ref } from 'vue';

/**
 * Which behavior cards hold unsaved edits (#105), so the page can warn
 * before switching section or leaving — either would drop the drafts.
 */
interface UnsavedDraftRegistry {
    mark(id: number, dirty: boolean): void;
}

const KEY: InjectionKey<UnsavedDraftRegistry> = Symbol('unsaved-behavior-drafts');

export function provideUnsavedDrafts() {
    const ids = ref(new Set<number>());
    provide(KEY, {
        mark(id, dirty) {
            const next = new Set(ids.value);
            if (dirty) next.add(id);
            else next.delete(id);
            ids.value = next;
        },
    });
    return { hasUnsaved: computed(() => ids.value.size > 0) };
}

/** Report a card's draft state for as long as the card is mounted. */
export function trackUnsavedDraft(id: number, dirty: Ref<boolean>): void {
    const registry = inject(KEY, null);
    if (!registry) return;
    watch(dirty, (value) => registry.mark(id, value), { immediate: true });
    onBeforeUnmount(() => registry.mark(id, false));
}

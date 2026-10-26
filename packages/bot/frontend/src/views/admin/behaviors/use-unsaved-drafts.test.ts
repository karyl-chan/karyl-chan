import { describe, expect, it } from 'vitest';
import { defineComponent, h, ref, type Ref } from 'vue';
import { mount } from '@vue/test-utils';
import { provideUnsavedDrafts, trackUnsavedDraft } from './use-unsaved-drafts';

describe('unsaved drafts', () => {
    it('a save that clears a draft is known at once — the page may follow the item right after', () => {
        const dirty = ref(true);
        let hasUnsaved: Ref<boolean> | null = null;
        const Form = defineComponent({
            setup() {
                trackUnsavedDraft('behavior:7', dirty);
                return () => null;
            },
        });
        mount(
            defineComponent({
                setup() {
                    hasUnsaved = provideUnsavedDrafts().hasUnsaved;
                    return () => h(Form);
                },
            })
        );
        expect(hasUnsaved!.value).toBe(true);
        // a card saves, then emits the saved item in the same tick; the page
        // asks whether leaving would drop drafts before Vue re-renders
        dirty.value = false;
        expect(hasUnsaved!.value).toBe(false);
    });
});

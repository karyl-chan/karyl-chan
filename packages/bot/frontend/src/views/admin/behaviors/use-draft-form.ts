import { computed, ref, watch, type Ref } from 'vue';
import { keepEditsOnWith, rebaseDraftWith, type DraftModel } from './draft-rebase';
import { trackUnsavedDraft } from './use-unsaved-drafts';

/**
 * The handler for the field components' `patch` events: they send what
 * changed, and it lands on the current draft (never on a stale copy).
 */
export function draftPatcher<D extends object>(draft: Ref<D>): (patch: Partial<D>) => void {
    return (patch) => {
        draft.value = { ...draft.value, ...patch };
    };
}

/**
 * A behavior form's saved row and edit draft, kept apart (#105) — the
 * same lifecycle for a message trigger, a command and a command leaf:
 *
 *   - a new version from the server (`saved` changes) rebases the edits
 *     or opens a conflict (rebaseDraftWith);
 *   - "keep mine" applies the edits onto the latest version, "discard"
 *     drops them;
 *   - a save refused as stale opens the conflict until the reload decides;
 *   - the draft counts for the page's leave guard while it differs.
 *
 * `key` names the form for that guard (see trackUnsavedDraft).
 */
export function useDraftForm<V, D extends object>(model: DraftModel<V, D>, saved: () => V, key: string) {
    const base = ref(saved()) as Ref<V>;
    const draft = ref(model.draftOf(saved())) as Ref<D>;
    const conflict = ref(false);
    /** The last save was refused as stale; the list was reloaded under the draft. */
    const stale = ref(false);
    const dirty = computed(() => model.patchOf(base.value, draft.value) !== null);
    trackUnsavedDraft(key, dirty);

    watch(saved, (incoming) => {
        if (incoming === base.value) return;
        const next = rebaseDraftWith(model, base.value, draft.value, incoming);
        base.value = next.base;
        draft.value = next.draft;
        conflict.value = next.conflict;
    });

    return {
        base,
        draft,
        conflict,
        stale,
        dirty,
        applyPatch: draftPatcher(draft),
        /** The PATCH saving the draft would send; null when it changes nothing. */
        pendingPatch() {
            return model.patchOf(base.value, draft.value);
        },
        /** Keep my edits, applied onto the latest version (the next save is based on it). */
        keepMine() {
            stale.value = false;
            draft.value = keepEditsOnWith(model, base.value, draft.value, saved());
            base.value = saved();
            conflict.value = false;
        },
        discard() {
            stale.value = false;
            base.value = saved();
            draft.value = model.draftOf(saved());
            conflict.value = false;
        },
        /** A save went through: the server's version is the new base, the draft follows it. */
        adopt(next: V) {
            base.value = next;
            draft.value = model.draftOf(next);
        },
        /**
         * A save was refused as stale: the reload decides — a changed form
         * field keeps the conflict open; otherwise the edits are rebased and
         * only need saving again.
         */
        refusedAsStale() {
            conflict.value = true;
            stale.value = true;
        },
    };
}

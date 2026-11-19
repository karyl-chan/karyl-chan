import { computed, reactive, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { replaceBehaviorDmAllowlist, type BehaviorDmAllowlist } from '../../../api/behavior';
import { describeBehaviorError } from './behavior-errors';
import { trackUnsavedDraft } from './use-unsaved-drafts';

function copy(list: BehaviorDmAllowlist): BehaviorDmAllowlist {
    return { userIds: [...list.userIds], groupNames: [...list.groupNames] };
}

function sameMembers(a: readonly string[], b: readonly string[]): boolean {
    if (a.length !== b.length) return false;
    const have = new Set(a);
    return b.every((item) => have.has(item));
}

/**
 * A behavior's DM allowlist as its form edits it: the saved list and a
 * draft, kept apart. Adding or removing only changes the draft; it is
 * written when the form is saved, together with the form's own fields,
 * and dropped when the form is cancelled.
 *
 * The form owns it (not BehaviorDirectMessages, which only shows it): the
 * section is unmounted whenever its card or leaf is closed, and the draft
 * has to outlive that. It counts for the page's leave guard while it
 * differs from the saved list.
 */
export function useDmAllowlistDraft(behaviorId: number) {
    const { t } = useI18n();
    const saved = ref<BehaviorDmAllowlist | null>(null);
    const draft = ref<BehaviorDmAllowlist | null>(null);
    const saving = ref(false);
    const error = ref<string | null>(null);

    const dirty = computed(
        () =>
            !!saved.value &&
            !!draft.value &&
            !(sameMembers(saved.value.userIds, draft.value.userIds) && sameMembers(saved.value.groupNames, draft.value.groupNames))
    );
    trackUnsavedDraft(`dm-allowlist:${behaviorId}`, dirty);

    return reactive({
        behaviorId,
        /** The list as the form shows it; null until it was loaded. */
        list: computed(() => draft.value),
        dirty,
        saving,
        error,
        /** The server's list arrived: edits in progress stay on top of it. */
        loaded(list: BehaviorDmAllowlist) {
            const keep = dirty.value;
            saved.value = list;
            if (!keep) draft.value = copy(list);
        },
        edit(next: BehaviorDmAllowlist) {
            error.value = null;
            draft.value = next;
        },
        discard() {
            error.value = null;
            if (saved.value) draft.value = copy(saved.value);
        },
        /** Write the draft. False when the server refused it: `error` says why, the draft stays. */
        async save(): Promise<boolean> {
            if (!dirty.value || !draft.value) return true;
            saving.value = true;
            error.value = null;
            try {
                const next = await replaceBehaviorDmAllowlist(behaviorId, draft.value);
                saved.value = next;
                draft.value = copy(next);
                return true;
            } catch (err) {
                error.value = describeBehaviorError(t, err);
                return false;
            } finally {
                saving.value = false;
            }
        },
    });
}

export type DmAllowlistDraft = ReturnType<typeof useDmAllowlistDraft>;

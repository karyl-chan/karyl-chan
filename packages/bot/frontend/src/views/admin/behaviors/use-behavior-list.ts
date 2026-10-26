import { computed, ref } from 'vue';
import {
    listBehaviors,
    type BehaviorListView,
    type BehaviorSection,
    type MessageTriggerView,
} from '../../../api/behavior';
import { sidebarSections } from './behavior-sections';

/**
 * The behaviors page's state: the list from GET /api/behaviors, the
 * selected section, and which card to open. Writes made by a card come
 * back through here, so the list, the sidebar and the open card follow
 * them without a page reload.
 */
export function useBehaviorList() {
    const view = ref<BehaviorListView | null>(null);
    const selected = ref<BehaviorSection | null>(null);
    const loading = ref(false);
    const error = ref<string | null>(null);
    /** The card to open next render (a trigger that just moved or was created). */
    const expandId = ref<number | null>(null);

    const sections = computed(() => (view.value ? sidebarSections(view.value) : []));

    async function load(): Promise<void> {
        loading.value = true;
        error.value = null;
        try {
            view.value = await listBehaviors();
            // Land on the section the login lives in — where the owner looks first.
            if (!selected.value || !sections.value.includes(selected.value)) {
                selected.value = view.value.system?.section ?? 'app';
            }
        } catch (err) {
            error.value = err instanceof Error ? err.message : String(err);
        } finally {
            loading.value = false;
        }
    }

    /** Follow a trigger to its section and open its card. */
    function reveal(trigger: MessageTriggerView): void {
        selected.value = trigger.section;
        expandId.value = trigger.id;
    }

    /** A card saved its trigger: take the server's version; follow it if it moved. */
    function applyTrigger(trigger: MessageTriggerView): void {
        const current = view.value;
        if (!current) return;
        const before = current.messageTriggers.find((m) => m.id === trigger.id);
        view.value = {
            ...current,
            messageTriggers: current.messageTriggers.map((m) => (m.id === trigger.id ? trigger : m)),
        };
        if (before && before.section !== trigger.section) reveal(trigger);
    }

    /** Audience Groups in use, with how many message triggers use each. */
    const groupUse = computed(() => {
        const use = new Map<string, number>();
        const triggers = view.value?.messageTriggers ?? [];
        for (const m of triggers) {
            if (m.audienceKind === 'group' && m.audienceGroupName) {
                use.set(m.audienceGroupName, (use.get(m.audienceGroupName) ?? 0) + 1);
            }
        }
        return use;
    });

    return { view, selected, loading, error, expandId, sections, groupUse, load, applyTrigger };
}

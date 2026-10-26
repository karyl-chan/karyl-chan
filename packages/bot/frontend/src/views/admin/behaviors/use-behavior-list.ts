import { computed, ref } from 'vue';
import {
    listBehaviors,
    reorderMessageTriggers,
    type BehaviorListView,
    type BehaviorSection,
    type MessageTriggerLocation,
    type MessageTriggerView,
} from '../../../api/behavior';
import { sidebarSections } from './behavior-sections';

/** Asks whether the page may switch section (dropping drafts there). */
export type MayLeave = () => Promise<boolean>;
const allowLeave: MayLeave = async () => true;

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

    /**
     * Follow a trigger to its section and open it — if leaving the current
     * section is all right (`mayLeave`: other cards there may hold unsaved
     * drafts the switch would drop).
     */
    async function follow(trigger: MessageTriggerView, mayLeave: MayLeave): Promise<void> {
        if (trigger.section === selected.value || (await mayLeave())) reveal(trigger);
    }

    /** A card saved its trigger: take the server's version; follow it if it moved. */
    async function applyTrigger(trigger: MessageTriggerView, mayLeave: MayLeave = allowLeave): Promise<void> {
        const current = view.value;
        if (!current) return;
        const before = current.messageTriggers.find((m) => m.id === trigger.id);
        view.value = {
            ...current,
            messageTriggers: current.messageTriggers.map((m) => (m.id === trigger.id ? trigger : m)),
        };
        if (before && before.section !== trigger.section) await follow(trigger, mayLeave);
    }

    /** A trigger was created: reload so it is listed, then open it where it lives (#104). */
    async function showCreated(trigger: MessageTriggerView, mayLeave: MayLeave = allowLeave): Promise<void> {
        await load();
        await follow(trigger, mayLeave);
    }

    /**
     * Put a location's triggers in a new order: shown at once, then saved
     * (PUT /api/behaviors/reorder). A refusal — typically stale, someone
     * added or moved a trigger there — reloads the list and is rethrown
     * for the page to report.
     */
    async function reorder(location: MessageTriggerLocation, ids: number[]): Promise<void> {
        const current = view.value;
        if (current) {
            const byId = new Map(current.messageTriggers.map((m) => [m.id, m]));
            const queue = ids.map((id) => byId.get(id)!).filter(Boolean);
            view.value = {
                ...current,
                messageTriggers: current.messageTriggers.map((m) =>
                    m.section === location && m.systemKey === null ? (queue.shift() ?? m) : m
                ),
            };
        }
        try {
            await reorderMessageTriggers(location, ids);
        } catch (err) {
            await load();
            throw err;
        }
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

    return { view, selected, loading, error, expandId, sections, groupUse, load, applyTrigger, showCreated, reorder };
}

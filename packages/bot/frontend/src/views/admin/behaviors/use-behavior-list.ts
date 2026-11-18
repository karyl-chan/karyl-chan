import { computed, ref } from 'vue';
import {
    listBehaviors,
    reorderMessageTriggers,
    type BehaviorItemView,
    type BehaviorListView,
    type BehaviorTargetKey,
    type BehaviorTargetView,
    type CommandView,
    type MessageTriggerView,
    type ServiceBehaviorView,
} from '../../../api/behavior';
import { itemKey } from './behavior-sections';
import { locationOrderAfter } from './behavior-targets';

/** Asks whether the page may switch target (dropping drafts there). */
export type MayLeave = () => Promise<boolean>;
const allowLeave: MayLeave = async () => true;

/**
 * The behaviors page's state: the list from GET /api/behaviors, the
 * selected Behavior Target, and which card to open. Writes made by a card
 * come back through here, so the list, the sidebar and the open card
 * follow them without a page reload.
 */
export function useBehaviorList() {
    const view = ref<BehaviorListView | null>(null);
    const selected = ref<BehaviorTargetKey | null>(null);
    const loading = ref(false);
    const error = ref<string | null>(null);
    /** The card to open next render (an item that just moved or was created): its itemKey. */
    const expandKey = ref<string | null>(null);

    /** The targets in display order: the built-in ones, then the created ones. */
    const targets = computed<BehaviorTargetView[]>(() => view.value?.targets ?? []);
    const selectedTarget = computed(() => targets.value.find((t) => t.key === selected.value) ?? null);

    async function load(): Promise<void> {
        loading.value = true;
        error.value = null;
        try {
            view.value = await listBehaviors();
            // Land on the target the login lives in — where the owner looks first.
            if (!selectedTarget.value) selected.value = view.value.system?.target ?? 'app';
        } catch (err) {
            error.value = err instanceof Error ? err.message : String(err);
        } finally {
            loading.value = false;
        }
    }

    /** Follow an item to its target and open its card. */
    function reveal(item: BehaviorItemView): void {
        selected.value = item.target;
        expandKey.value = itemKey(item);
    }

    /**
     * Follow an item to its target and open it — if leaving the current
     * target is all right (`mayLeave`: other cards there may hold unsaved
     * drafts the switch would drop).
     */
    async function follow(item: BehaviorItemView, mayLeave: MayLeave): Promise<void> {
        if (item.target === selected.value || (await mayLeave())) reveal(item);
    }

    /**
     * An item moved to a target the list has not heard of (a trigger saved
     * for a user typed in by id): the server registered it with that write,
     * so reload to list it before following the item there.
     */
    async function followMoved(item: BehaviorItemView, mayLeave: MayLeave): Promise<void> {
        if (!targets.value.some((t) => t.key === item.target)) await load();
        await follow(item, mayLeave);
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
        if (before && before.target !== trigger.target) await followMoved(trigger, mayLeave);
    }

    /**
     * A card wrote its command (an edit, a resync, a leaf write): take the
     * server's version; follow it if its visibility moved it.
     */
    async function applyCommand(command: CommandView, mayLeave: MayLeave = allowLeave): Promise<void> {
        const current = view.value;
        if (!current) return;
        const before = current.commands.find((c) => c.id === command.id);
        view.value = {
            ...current,
            commands: current.commands.map((c) => (c.id === command.id ? command : c)),
        };
        if (before && before.target !== command.target) await followMoved(command, mayLeave);
    }

    /**
     * The login's trigger was switched (or its command resynced): take the
     * server's version; follow it when the switch moved it to another
     * target (a message pattern lives in bot DMs, a command where its
     * visibility puts it).
     */
    async function applySystem(system: BehaviorItemView, mayLeave: MayLeave = allowLeave): Promise<void> {
        const current = view.value;
        if (!current) return;
        const before = current.system;
        view.value = { ...current, system };
        if (before && before.target !== system.target) await followMoved(system, mayLeave);
    }

    /**
     * A Service Behavior's trigger was switched: take the server's version
     * (by service — a switch to a command changes the item's id); follow
     * it when the switch moved it to another target.
     */
    async function applyService(behavior: ServiceBehaviorView, mayLeave: MayLeave = allowLeave): Promise<void> {
        const current = view.value;
        if (!current) return;
        const before = current.services.find((s) => s.service.id === behavior.service.id);
        view.value = {
            ...current,
            services: current.services.map((s) => (s.service.id === behavior.service.id ? behavior : s)),
        };
        if (before && before.target !== behavior.target) await followMoved(behavior, mayLeave);
    }

    /** An item was created (or converted to the other kind, #172): reload so it is listed, then open it where it lives (#104). */
    async function showCreated(item: BehaviorItemView, mayLeave: MayLeave = allowLeave): Promise<void> {
        await load();
        await follow(item, mayLeave);
    }

    /**
     * A target was created: reload so it is listed, and go to it — if
     * leaving the current target is all right.
     */
    async function showTarget(target: BehaviorTargetView, mayLeave: MayLeave = allowLeave): Promise<void> {
        await load();
        if (target.key !== selected.value && (await mayLeave())) selected.value = target.key;
    }

    /**
     * A form created a target from its own target select: list it, and
     * stay where the form is — its draft is not saved yet.
     */
    async function listTarget(target: BehaviorTargetView): Promise<void> {
        const current = view.value;
        if (!current || current.targets.some((t) => t.key === target.key)) return;
        // shown at once; the reload puts it in its place in the order
        view.value = { ...current, targets: [...current.targets, target] };
        await load();
    }

    /** A group's member list changed: the sidebar shows the new count. */
    function applyMemberCount(key: BehaviorTargetKey, memberCount: number): void {
        const current = view.value;
        if (!current) return;
        view.value = {
            ...current,
            targets: current.targets.map((t) => (t.key === key ? { ...t, memberCount } : t)),
        };
    }

    /**
     * Put a target's triggers in a new order: shown at once, then saved
     * (PUT /api/behaviors/reorder, by the target's location — the other
     * targets' triggers there keep their places). A refusal — typically
     * stale, someone added or moved a trigger there — reloads the list
     * and is rethrown for the page to report.
     */
    async function reorder(target: BehaviorTargetView, ids: number[]): Promise<void> {
        const current = view.value;
        if (!current) return;
        const order = locationOrderAfter(current, target, ids);
        if (!order) return;
        const byId = new Map(current.messageTriggers.map((m) => [m.id, m]));
        const queue = ids.map((id) => byId.get(id)!).filter(Boolean);
        view.value = {
            ...current,
            messageTriggers: current.messageTriggers.map((m) =>
                m.target === target.key && m.systemKey === null ? (queue.shift() ?? m) : m
            ),
        };
        try {
            await reorderMessageTriggers(order.location, order.ids);
        } catch (err) {
            await load();
            throw err;
        }
    }

    return {
        view,
        selected,
        selectedTarget,
        loading,
        error,
        expandKey,
        targets,
        load,
        applyTrigger,
        applyCommand,
        applySystem,
        applyService,
        applyMemberCount,
        showCreated,
        showTarget,
        listTarget,
        reorder,
    };
}

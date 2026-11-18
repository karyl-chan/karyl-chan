import type {
    BehaviorItemView,
    BehaviorListView,
    BehaviorSection,
    BehaviorTargetKey,
    BehaviorTargetView,
    CommandView,
    MessageTriggerLocation,
    MessageTriggerView,
    ServiceBehaviorView,
} from '../../../api/behavior';

/**
 * Grouping of the behaviors page by Behavior Target (ADR 0004). The server
 * derives each item's `target` and lists the targets in display order;
 * this file only reads those — it never works out a target from trigger
 * fields, nor takes a key apart (a target view carries its own fields).
 */

export interface TargetItems {
    /** The System Behavior when it belongs to this target — pinned on top. */
    system: BehaviorItemView | null;
    /** The Service Behaviors here (#126) — under the login, apart from the custom triggers. */
    services: ServiceBehaviorView[];
    commands: CommandView[];
    messageTriggers: MessageTriggerView[];
}

export function itemsInTarget(view: BehaviorListView, key: BehaviorTargetKey): TargetItems {
    return {
        system: view.system && view.system.target === key ? view.system : null,
        services: view.services.filter((s) => s.target === key),
        commands: view.commands.filter((c) => c.target === key),
        messageTriggers: view.messageTriggers.filter((t) => t.target === key),
    };
}

/** Number of behaviors (leaves + triggers) among a target's items. */
export function countInTargetItems(items: TargetItems): number {
    return (
        (items.system ? 1 : 0) +
        items.services.length +
        items.commands.reduce((n, c) => n + c.leaves.length, 0) +
        items.messageTriggers.length
    );
}

/** Number of behaviors in a target, for the sidebar. */
export function countInTarget(view: BehaviorListView, key: BehaviorTargetKey): number {
    return countInTargetItems(itemsInTarget(view, key));
}

/**
 * The Message Trigger Location a target's triggers are at: a user's and a
 * group's are in bot DMs. Null for App 指令, which holds commands only.
 */
export function locationOfTarget(target: BehaviorTargetView): MessageTriggerLocation | null {
    switch (target.kind) {
        case 'app':
            return null;
        case 'user':
        case 'group':
            return 'bot_dm';
        default:
            return target.key as MessageTriggerLocation;
    }
}

/**
 * The Behavior Section a location-only target is — what a new command's
 * visibility is preset from. Null for a user or a group: a command has no
 * audience, so none can belong there.
 */
export function sectionOfTarget(target: BehaviorTargetView): BehaviorSection | null {
    return target.kind === 'user' || target.kind === 'group' ? null : (target.key as BehaviorSection);
}

/**
 * A new order for one target's message triggers, as the reorder API takes
 * it: the whole order of the target's location, with `ids` put in the
 * slots the target's triggers hold there. Triggers are ordered by
 * location (the three bot DM kinds of target share one), so the other
 * targets' triggers keep their places. Null when the target holds no
 * message triggers.
 */
export function locationOrderAfter(
    view: BehaviorListView,
    target: BehaviorTargetView,
    ids: readonly number[],
): { location: MessageTriggerLocation; ids: number[] } | null {
    const location = locationOfTarget(target);
    if (!location) return null;
    const queue = [...ids];
    return {
        location,
        ids: view.messageTriggers
            // a message trigger's section is its location's key
            .filter((m) => m.section === location && m.systemKey === null)
            .map((m) => (m.target === target.key ? (queue.shift() ?? m.id) : m.id)),
    };
}

import { computed, ref, watch, type Ref } from 'vue';
import { getGroupMembers, type MessageTriggerView } from '../../../api/behavior';
import { toCreateBody, type MessageTriggerDraft } from './message-trigger-draft';

/**
 * An Audience Group's member list lives only while some message trigger
 * uses the group (#137): when the last one changes its audience, renames
 * the group or is deleted, the bot drops the list. This is the group a
 * trigger is the sole user of — the list its save or delete would drop.
 */
export function soleGroupOf(trigger: MessageTriggerView, groupUse: ReadonlyMap<string, number>): string | null {
    const name = trigger.audienceKind === 'group' ? trigger.audienceGroupName : null;
    return name && groupUse.get(name) === 1 ? name : null;
}

/** Whether saving the draft stops using the group. */
export function draftLeavesGroup(group: string, draft: MessageTriggerDraft): boolean {
    return toCreateBody(draft).audienceGroupName !== group;
}

/**
 * The sole group of a saved trigger and how many members its list has,
 * loaded while the card is open (and on demand before a delete).
 */
export function useSoleGroup(
    saved: Ref<MessageTriggerView>,
    groupUse: () => ReadonlyMap<string, number>,
    open: Ref<boolean>,
) {
    const group = computed(() => soleGroupOf(saved.value, groupUse()));
    const members = ref<number | null>(null);

    async function load(): Promise<number> {
        const name = group.value;
        if (!name) return 0;
        if (members.value === null) {
            members.value = await getGroupMembers(name)
                .then((r) => r.members.length)
                .catch(() => null);
        }
        return members.value ?? 0;
    }

    watch(
        [open, group],
        ([isOpen, name]) => {
            members.value = null;
            if (isOpen && name) void load();
        },
        { immediate: true }
    );

    return { group, members, load };
}

<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { AppButton, Spacer, useConfirm } from '@karyl-chan/ui';
import { deleteBehaviorTarget, type BehaviorTargetView } from '../../../api/behavior';
import { useCurrentUserStore } from '../../../stores/currentUserStore';
import { describeBehaviorError } from './behavior-errors';
import GroupMembersPanel from './GroupMembersPanel.vue';
import { targetKind } from './target-labels';

/**
 * The head of a Behavior Target's view: what it is, "new behavior", and —
 * for a target the admin created — deleting it. A group's members are
 * edited here, in one place, from the moment the group exists (ADR 0004).
 *
 * A target is deleted only when nothing uses it; the button says why it
 * cannot be otherwise. A group named in DM allowlists shows how many: its
 * own list of behaviors does not include those.
 */
const props = defineProps<{
    target: BehaviorTargetView;
    label: string;
    /** How many behaviors belong to the target. */
    count: number;
}>();

const emit = defineEmits<{
    (e: 'add'): void;
    (e: 'deleted', target: BehaviorTargetView): void;
    /** A group's member count, after its panel loaded or saved. */
    (e: 'members', count: number): void;
}>();

const { t } = useI18n();
const { confirm } = useConfirm();
const currentUser = useCurrentUserStore();

const deleting = ref(false);
const error = ref<string | null>(null);

const group = computed(() => (props.target.kind === 'group' ? props.target.groupName : null));
/** A group a service's login uses: its members are who may log in — an owner's call (#126). */
const membersLocked = computed(() => props.target.ownerOnly && currentUser.user?.isOwner !== true);

const blocked = computed(() => {
    if (props.count > 0) return t('behaviors.target.delete.hasBehaviors', { count: props.count });
    if (props.target.allowlistRefs > 0) {
        return t('behaviors.target.delete.inAllowlists', { count: props.target.allowlistRefs });
    }
    return null;
});

async function remove() {
    const id = props.target.id;
    if (id === null || blocked.value || deleting.value) return;
    const ok = await confirm({
        title: t('behaviors.target.delete.title'),
        message: t(group.value ? 'behaviors.target.delete.messageGroup' : 'behaviors.target.delete.message', {
            name: props.label,
        }),
        confirmLabel: t('behaviors.target.delete.confirm'),
        confirmVariant: 'danger',
        cancelLabel: t('common.cancel'),
    });
    if (!ok) return;
    deleting.value = true;
    error.value = null;
    try {
        await deleteBehaviorTarget(id);
        emit('deleted', props.target);
    } catch (err) {
        error.value = describeBehaviorError(t, err);
    } finally {
        deleting.value = false;
    }
}
</script>

<template>
    <div class="target-head">
        <header class="row">
            <h2 class="title">{{ label }}</h2>
            <span class="kind-badge">{{ targetKind(t, target) }}</span>
            <Spacer />
            <AppButton
                v-if="!target.builtin"
                size="sm"
                variant="ghost"
                icon="material-symbols:delete-outline-rounded"
                data-test="delete-target"
                :disabled="blocked !== null"
                :loading="deleting"
                :title="blocked ?? undefined"
                @click="remove"
            >
                {{ t('behaviors.target.delete.open') }}
            </AppButton>
            <AppButton size="sm" icon="material-symbols:add-rounded" data-test="add-behavior" @click="emit('add')">
                {{ t('behaviors.add.open') }}
            </AppButton>
        </header>

        <p v-if="error" class="error" role="alert" data-test="target-error">{{ error }}</p>

        <template v-if="group">
            <GroupMembersPanel
                :key="group"
                :group-name="group"
                :used-by="1"
                :readonly="membersLocked"
                @members="emit('members', $event)"
            />
            <p v-if="target.allowlistRefs > 0" class="refs" data-test="allowlist-refs">
                {{ t('behaviors.target.allowlistRefs', { count: target.allowlistRefs }) }}
            </p>
        </template>
    </div>
</template>

<style scoped>
.target-head {
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
    flex-shrink: 0;
}
.row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
}
.title { margin: 0; font-size: 1.05rem; color: var(--text-strong); }
.kind-badge {
    font-size: 0.72rem;
    padding: 0.12rem 0.45rem;
    border-radius: 999px;
    background: var(--bg-page);
    border: 1px solid var(--border);
    color: var(--text-muted);
}
.refs { margin: 0; font-size: 0.78rem; color: var(--text-muted); }
.error { margin: 0; font-size: 0.85rem; color: var(--danger); }
</style>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { onBeforeRouteLeave } from 'vue-router';
import { SidebarLayout } from '../../../layouts';
import { useBreakpoint, useAppShell, useConfirm, useToastStore } from '@karyl-chan/ui';
import TargetSidebar from './TargetSidebar.vue';
import BehaviorWorkspace from './BehaviorWorkspace.vue';
import AddBehaviorModal from './AddBehaviorModal.vue';
import CreateTargetDialog from './CreateTargetDialog.vue';
import type { BehaviorTargetKey, BehaviorTargetView } from '../../../api/behavior';
import { describeBehaviorError, isStale } from './behavior-errors';
import { countInTarget, itemsInTarget } from './behavior-targets';
import { provideTargetDirectory } from './target-directory';
import { targetLabel } from './target-labels';
import { useBehaviorList } from './use-behavior-list';
import { provideRegistrationResults } from './use-registration-results';
import { useTargetNames } from './use-target-names';
import { provideUnsavedDrafts } from './use-unsaved-drafts';

const { t } = useI18n();
const { isMobile } = useBreakpoint();
const { closeOverlay } = useAppShell();
const { confirm } = useConfirm();

const toast = useToastStore();
const {
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
} = useBehaviorList();
const adding = ref(false);
const creatingTarget = ref(false);
const { hasUnsaved } = provideUnsavedDrafts();
provideRegistrationResults();

/** Guild, channel and user names are a nicety: without the access to read them the page shows ids. */
const names = useTargetNames(targets);
// every form's target select offers what the sidebar lists
provideTargetDirectory({ targets, names, created: listTarget, open: (key) => onSelect(key) });

const counts = computed(() => {
    const map: Record<string, number> = {};
    if (view.value) for (const target of targets.value) map[target.key] = countInTarget(view.value, target.key);
    return map;
});
const selectedItems = computed(() =>
    view.value && selected.value ? itemsInTarget(view.value, selected.value) : null
);
const selectedLabel = computed(() =>
    selectedTarget.value ? targetLabel(t, selectedTarget.value, names.value) : ''
);

/** Leaving the target (or the page) unmounts its cards and drops their drafts (#105). */
async function mayDropDrafts(): Promise<boolean> {
    if (!hasUnsaved.value) return true;
    return confirm({
        title: t('behaviors.unsaved.title'),
        message: t('behaviors.unsaved.message'),
        confirmLabel: t('behaviors.unsaved.leave'),
        confirmVariant: 'danger',
        cancelLabel: t('common.cancel'),
    });
}

function onBeforeUnload(event: BeforeUnloadEvent) {
    if (!hasUnsaved.value) return;
    event.preventDefault();
    event.returnValue = '';
}

onMounted(() => {
    void load();
    window.addEventListener('beforeunload', onBeforeUnload);
});
onBeforeUnmount(() => window.removeEventListener('beforeunload', onBeforeUnload));
onBeforeRouteLeave(() => mayDropDrafts());

async function onReorder(ids: number[]) {
    if (!selectedTarget.value) return;
    try {
        await reorder(selectedTarget.value, ids);
    } catch (err) {
        // the list was reloaded either way; say why the order did not stick
        if (isStale(err)) toast.show(t('behaviors.workspace.reorderStale'), 'warn');
        else toast.show(describeBehaviorError(t, err));
    }
}

async function onSelect(key: BehaviorTargetKey) {
    if (key !== selected.value && !(await mayDropDrafts())) return;
    selected.value = key;
    if (isMobile.value) closeOverlay();
}

async function onTargetCreated(target: BehaviorTargetView) {
    await showTarget(target, mayDropDrafts);
    if (isMobile.value) closeOverlay();
}
</script>

<template>
    <SidebarLayout>
        <template #sidebar>
            <TargetSidebar
                :targets="targets"
                :counts="counts"
                :selected="selected"
                :names="names"
                :loading="loading"
                @select="onSelect"
                @create="creatingTarget = true"
            />
        </template>

        <BehaviorWorkspace
            v-if="selectedTarget"
            :target="selectedTarget"
            :label="selectedLabel"
            :items="selectedItems"
            :guild-names="names.guilds"
            :commands="view?.commands ?? []"
            :expand-key="expandKey"
            :loading="loading"
            :error="error"
            @retry="load"
            @reload="load"
            @updated="applyTrigger($event, mayDropDrafts)"
            @command-updated="applyCommand($event, mayDropDrafts)"
            @system-updated="applySystem($event, mayDropDrafts)"
            @service-updated="applyService($event, mayDropDrafts)"
            @deleted="load"
            @converted="showCreated($event, mayDropDrafts)"
            @add="adding = true"
            @reorder="onReorder"
            @target-deleted="load"
            @members="applyMemberCount(selectedTarget.key, $event)"
        />
        <p v-else-if="error" class="page-error" role="alert">{{ error }}</p>

        <AddBehaviorModal
            v-if="selectedTarget"
            :visible="adding"
            :target="selectedTarget"
            :target-label="selectedLabel"
            :guild-names="names.guilds"
            @close="adding = false"
            @created="showCreated($event, mayDropDrafts)"
            @reload="load"
        />

        <CreateTargetDialog
            :visible="creatingTarget"
            @close="creatingTarget = false"
            @created="onTargetCreated"
        />
    </SidebarLayout>
</template>

<style scoped>
.page-error {
    color: var(--danger);
    padding: 1rem;
}
</style>

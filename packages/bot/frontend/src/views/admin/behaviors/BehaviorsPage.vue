<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { onBeforeRouteLeave } from 'vue-router';
import { SidebarLayout } from '../../../layouts';
import { useBreakpoint, useAppShell, useConfirm, useToastStore } from '@karyl-chan/ui';
import { useGuildListStore } from '../../../stores/guildListStore';
import BehaviorSidebar from './BehaviorSidebar.vue';
import BehaviorWorkspace from './BehaviorWorkspace.vue';
import AddBehaviorModal from './AddBehaviorModal.vue';
import type { BehaviorSection } from '../../../api/behavior';
import { messageTriggerLocationOf } from './message-trigger-location';
import { describeBehaviorError, isStale } from './behavior-errors';
import { countInSection, itemsInSection } from './behavior-sections';
import { useBehaviorList } from './use-behavior-list';
import { provideRegistrationResults } from './use-registration-results';
import { provideUnsavedDrafts } from './use-unsaved-drafts';

const { t } = useI18n();
const { isMobile } = useBreakpoint();
const { closeOverlay } = useAppShell();
const { confirm } = useConfirm();
const guildList = useGuildListStore();

const toast = useToastStore();
const { view, selected, loading, error, expandKey, sections, groupUse, load, applyTrigger, applyCommand, showCreated, reorder } =
    useBehaviorList();
const adding = ref(false);
const { hasUnsaved } = provideUnsavedDrafts();
provideRegistrationResults();

const counts = computed(() => {
    const map: Record<string, number> = {};
    if (view.value) for (const s of sections.value) map[s] = countInSection(view.value, s);
    return map;
});
const selectedItems = computed(() =>
    view.value && selected.value ? itemsInSection(view.value, selected.value) : null
);
const groupNames = computed(() => [...groupUse.value.keys()].sort());
const guildNames = computed(() => new Map(guildList.guilds.map((g) => [g.id, g.name])));

/** Leaving the section (or the page) unmounts its cards and drops their drafts (#105). */
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
    // Guild names are a nicety: without guild access the sidebar shows ids.
    void guildList.ensure().catch(() => undefined);
    window.addEventListener('beforeunload', onBeforeUnload);
});
onBeforeUnmount(() => window.removeEventListener('beforeunload', onBeforeUnload));
onBeforeRouteLeave(() => mayDropDrafts());

async function onReorder(ids: number[]) {
    const location = selected.value ? messageTriggerLocationOf(selected.value) : null;
    if (!location) return;
    try {
        await reorder(location, ids);
    } catch (err) {
        // the list was reloaded either way; say why the order did not stick
        if (isStale(err)) toast.show(t('behaviors.workspace.reorderStale'), 'warn');
        else toast.show(describeBehaviorError(t, err));
    }
}

async function onSelect(section: BehaviorSection) {
    if (section !== selected.value && !(await mayDropDrafts())) return;
    selected.value = section;
    if (isMobile.value) closeOverlay();
}
</script>

<template>
    <SidebarLayout>
        <template #sidebar>
            <BehaviorSidebar
                :sections="sections"
                :counts="counts"
                :selected="selected"
                :guild-names="guildNames"
                :loading="loading"
                @select="onSelect"
            />
        </template>

        <BehaviorWorkspace
            v-if="selected"
            :section="selected"
            :items="selectedItems"
            :guild-names="guildNames"
            :group-names="groupNames"
            :group-use="groupUse"
            :expand-key="expandKey"
            :loading="loading"
            :error="error"
            @retry="load"
            @reload="load"
            @updated="applyTrigger($event, mayDropDrafts)"
            @command-updated="applyCommand($event, mayDropDrafts)"
            @deleted="load"
            @add="adding = true"
            @reorder="onReorder"
        />
        <p v-else-if="error" class="page-error" role="alert">{{ error }}</p>

        <AddBehaviorModal
            v-if="selected"
            :visible="adding"
            :section="selected"
            :guild-names="guildNames"
            :group-names="groupNames"
            @close="adding = false"
            @created="showCreated($event, mayDropDrafts)"
        />
    </SidebarLayout>
</template>

<style scoped>
.page-error {
    color: var(--danger);
    padding: 1rem;
}
</style>

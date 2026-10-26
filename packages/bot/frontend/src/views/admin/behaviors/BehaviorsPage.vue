<script setup lang="ts">
import { computed, onMounted } from 'vue';
import { SidebarLayout } from '../../../layouts';
import { useBreakpoint, useAppShell } from '@karyl-chan/ui';
import { useGuildListStore } from '../../../stores/guildListStore';
import BehaviorSidebar from './BehaviorSidebar.vue';
import BehaviorWorkspace from './BehaviorWorkspace.vue';
import type { BehaviorSection } from '../../../api/behavior';
import { countInSection, itemsInSection } from './behavior-sections';
import { useBehaviorList } from './use-behavior-list';

const { isMobile } = useBreakpoint();
const { closeOverlay } = useAppShell();
const guildList = useGuildListStore();

const { view, selected, loading, error, expandId, sections, groupUse, load, applyTrigger } =
    useBehaviorList();

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

onMounted(() => {
    void load();
    // Guild names are a nicety: without guild access the sidebar shows ids.
    void guildList.ensure().catch(() => undefined);
});

function onSelect(section: BehaviorSection) {
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
            :expand-id="expandId"
            :loading="loading"
            :error="error"
            @retry="load"
            @reload="load"
            @updated="applyTrigger"
            @deleted="load"
        />
        <p v-else-if="error" class="page-error" role="alert">{{ error }}</p>
    </SidebarLayout>
</template>

<style scoped>
.page-error {
    color: var(--danger);
    padding: 1rem;
}
</style>

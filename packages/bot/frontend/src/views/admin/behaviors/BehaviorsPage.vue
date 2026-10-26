<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { SidebarLayout } from '../../../layouts';
import { useBreakpoint, useAppShell } from '@karyl-chan/ui';
import { useGuildListStore } from '../../../stores/guildListStore';
import BehaviorSidebar from './BehaviorSidebar.vue';
import BehaviorWorkspace from './BehaviorWorkspace.vue';
import { listBehaviors, type BehaviorListView, type BehaviorSection } from '../../../api/behavior';
import { countInSection, itemsInSection, sidebarSections } from './behavior-sections';

const { isMobile } = useBreakpoint();
const { closeOverlay } = useAppShell();
const guildList = useGuildListStore();

const view = ref<BehaviorListView | null>(null);
const selected = ref<BehaviorSection | null>(null);
const loading = ref(false);
const error = ref<string | null>(null);

const sections = computed(() => (view.value ? sidebarSections(view.value) : []));
const counts = computed(() => {
    const map: Record<string, number> = {};
    if (view.value) for (const s of sections.value) map[s] = countInSection(view.value, s);
    return map;
});
const selectedItems = computed(() =>
    view.value && selected.value ? itemsInSection(view.value, selected.value) : null
);
const guildNames = computed(() => new Map(guildList.guilds.map((g) => [g.id, g.name])));

async function load() {
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
            :loading="loading"
            :error="error"
            @retry="load"
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

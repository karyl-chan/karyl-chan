<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { Icon } from '@iconify/vue';
import { deletePlugin, listPlugins, type PluginRecord } from '../../../api/plugins';
import PluginCard from './PluginCard.vue';
import { AppButton, AppConfirmDialog } from '@karyl-chan/ui';
import AddPluginModal from './AddPluginModal.vue';
import { pluginInstallState } from './plugin-install-state';

const { t } = useI18n();

const plugins = ref<PluginRecord[]>([]);
const loading = ref(false);
const error = ref<string | null>(null);
const offlineOpen = ref(false);

// Awaiting-registration placeholders get their own always-visible group:
// they are born status=active (and reaper-flip to inactive later), so the
// plain online/offline split would show a never-registered plugin as
// "Online" for a minute and then bury it in the collapsed offline list —
// exactly the silence PD-1.2 removes.
const pendingPlugins = computed(() =>
    plugins.value.filter(p => pluginInstallState(p) === 'awaiting-registration')
);
const activePlugins = computed(() =>
    plugins.value.filter(p => p.status === 'active' && pluginInstallState(p) !== 'awaiting-registration')
);
const inactivePlugins = computed(() =>
    plugins.value.filter(p => p.status === 'inactive' && pluginInstallState(p) !== 'awaiting-registration')
);

async function load() {
    loading.value = true;
    error.value = null;
    try {
        plugins.value = await listPlugins();
    } catch (err) {
        error.value = err instanceof Error ? err.message : String(err);
    } finally {
        loading.value = false;
    }
}

function onUpdated(updated: { id: number; pluginKey: string; enabled: boolean }) {
    plugins.value = plugins.value.map(p =>
        p.id === updated.id ? { ...p, enabled: updated.enabled } : p
    );
}

function onDeleted(id: number) {
    plugins.value = plugins.value.filter(p => p.id !== id);
}

// ── Delete-all-offline ───────────────────────────────────────────
const deleteAllModalOpen = ref(false);
const deletingAll = ref(false);
const deleteAllError = ref<string | null>(null);
const deleteAllProgress = ref<{ done: number; total: number } | null>(null);

async function confirmDeleteAllOffline() {
    if (deletingAll.value) return;
    const targets = inactivePlugins.value.slice();
    if (targets.length === 0) {
        deleteAllModalOpen.value = false;
        return;
    }
    deletingAll.value = true;
    deleteAllError.value = null;
    deleteAllProgress.value = { done: 0, total: targets.length };
    const failures: string[] = [];
    for (const p of targets) {
        try {
            await deletePlugin(p.id);
            plugins.value = plugins.value.filter(x => x.id !== p.id);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            failures.push(`${p.pluginKey}: ${msg}`);
        }
        deleteAllProgress.value = {
            done: (deleteAllProgress.value?.done ?? 0) + 1,
            total: targets.length,
        };
    }
    deletingAll.value = false;
    if (failures.length === 0) {
        deleteAllModalOpen.value = false;
        deleteAllProgress.value = null;
    } else {
        deleteAllError.value = failures.join('\n');
    }
}

function closeDeleteAllModal() {
    if (deletingAll.value) return;
    deleteAllModalOpen.value = false;
    deleteAllError.value = null;
    deleteAllProgress.value = null;
}

// ── Add plugin modal ─────────────────────────────────────────────
const addPluginModalOpen = ref(false);

function onPluginCreated() {
    // The fresh placeholder lands in the always-visible pending group.
    void load();
}

onMounted(load);
</script>

<template>
    <div class="page">
        <header class="page-head">
            <h1 class="title">{{ t('admin.plugins.title') }}</h1>
            <p class="subtitle">{{ t('admin.plugins.subtitle') }}</p>
            <AppButton
                variant="primary"
                icon="material-symbols:add-circle-outline"
                @click="addPluginModalOpen = true"
            >
                {{ t('admin.plugins.addPlugin.button') }}
            </AppButton>
            <AppButton
                variant="ghost"
                icon="material-symbols:refresh"
                :disabled="loading"
                :title="t('common.refresh')"
                :aria-label="t('common.refresh')"
                @click="load"
            />
        </header>

        <p v-if="loading && plugins.length === 0" class="muted">{{ t('common.loading') }}</p>
        <p v-else-if="!loading && plugins.length === 0" class="muted empty">
            <Icon icon="material-symbols:extension-outline" width="32" height="32" />
            <span>{{ t('admin.plugins.empty') }}</span>
            <small>{{ t('admin.plugins.emptyHint') }}</small>
        </p>
        <p v-if="error" class="error" role="alert">{{ error }}</p>

        <!-- Awaiting first registration (PD-1.2: never silent) -->
        <div v-if="pendingPlugins.length > 0" class="group">
            <div class="group-head">
                <span class="group-dot pending" />
                <span class="group-label">{{ t('admin.plugins.installState.pendingGroup') }}</span>
                <span class="group-count">{{ pendingPlugins.length }}</span>
            </div>
            <p class="group-hint">{{ t('admin.plugins.installState.pendingGroupHint') }}</p>
            <div class="card-list">
                <PluginCard
                    v-for="p in pendingPlugins"
                    :key="p.id"
                    :plugin="p"
                    @updated="onUpdated"
                    @deleted="onDeleted"
                />
            </div>
        </div>

        <!-- Online group -->
        <div v-if="activePlugins.length > 0" class="group">
            <div class="group-head">
                <span class="group-dot online" />
                <span class="group-label">{{ t('admin.plugins.online') }}</span>
                <span class="group-count">{{ activePlugins.length }}</span>
            </div>
            <div class="card-list">
                <PluginCard
                    v-for="p in activePlugins"
                    :key="p.id"
                    :plugin="p"
                    @updated="onUpdated"
                    @deleted="onDeleted"
                />
            </div>
        </div>

        <!-- Offline group (collapsible, default collapsed) -->
        <div v-if="inactivePlugins.length > 0" class="group">
            <div class="group-head group-head-offline">
                <button type="button" class="group-toggle-btn" @click="offlineOpen = !offlineOpen">
                    <span class="group-dot offline" />
                    <span class="group-label">{{ t('admin.plugins.offlineCount', { n: inactivePlugins.length }) }}</span>
                    <Icon
                        :icon="offlineOpen ? 'material-symbols:expand-less-rounded' : 'material-symbols:expand-more-rounded'"
                        width="16"
                        height="16"
                        class="group-chevron"
                    />
                </button>
                <AppButton
                    variant="danger"
                    size="sm"
                    icon="material-symbols:delete-sweep-outline"
                    :disabled="deletingAll"
                    :title="t('admin.plugins.deleteAllOffline')"
                    @click="deleteAllModalOpen = true"
                >
                    {{ t('admin.plugins.deleteAllOffline') }}
                </AppButton>
            </div>
            <div v-if="offlineOpen" class="card-list">
                <PluginCard
                    v-for="p in inactivePlugins"
                    :key="p.id"
                    :plugin="p"
                    @updated="onUpdated"
                    @deleted="onDeleted"
                />
            </div>
        </div>

        <AddPluginModal
            :visible="addPluginModalOpen"
            @close="addPluginModalOpen = false"
            @created="onPluginCreated"
        />

        <AppConfirmDialog
            :visible="deleteAllModalOpen"
            :title="t('admin.plugins.deleteAllConfirmTitle')"
            :message="t('admin.plugins.deleteAllConfirm', { n: inactivePlugins.length })"
            :confirm-label="t('admin.plugins.deleteAllOffline')"
            confirm-variant="danger"
            :loading="deletingAll"
            :error="deleteAllError ?? undefined"
            :progress="deleteAllProgress ? t('admin.plugins.deleteAllProgress', { done: deleteAllProgress.done, total: deleteAllProgress.total }) : undefined"
            @close="closeDeleteAllModal"
            @confirm="confirmDeleteAllOffline"
        />
    </div>
</template>

<style scoped>
.page {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    padding: 0.75rem;
    height: 100%;
    overflow-y: auto;
}
.page-head {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
}
.title { margin: 0; font-size: 1.1rem; color: var(--text-strong); }
.subtitle {
    margin: 0;
    color: var(--text-muted);
    font-size: 0.85rem;
    flex: 1;
    min-width: 0;
}
.muted { color: var(--text-muted); }
.muted.empty {
    text-align: center;
    padding: 2rem 1rem;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.4rem;
}
.muted.empty small { color: var(--text-faint); font-size: 0.78rem; max-width: 32rem; }

.error { color: var(--danger); margin: 0; font-size: 0.9rem; }

.card-list {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
}

/* ── Plugin groups (online / offline) ───────────────────────────── */
.group {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
}
.group-head {
    display: flex;
    align-items: center;
    gap: 0.45rem;
    padding: 0.2rem 0.1rem;
}
.group-toggle,
.group-toggle-btn {
    background: none;
    border: none;
    cursor: pointer;
    color: var(--text-muted);
    text-align: left;
    padding: 0;
    display: flex;
    align-items: center;
    gap: 0.45rem;
}
.group-toggle:hover .group-label,
.group-toggle-btn:hover .group-label { color: var(--text); }
.group-head-offline {
    justify-content: space-between;
}
.group-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
}
.group-dot.online  { background: var(--success, #16a34a); }
.group-dot.offline { background: var(--text-muted); }
.group-dot.pending { background: var(--warning, #d97706); }
.group-hint {
    margin: 0 0 0.1rem;
    font-size: 0.78rem;
    color: var(--text-muted);
    line-height: 1.45;
}
.group-label {
    font-size: 0.82rem;
    font-weight: 600;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
}
.group-count {
    font-size: 0.78rem;
    color: var(--text-faint, var(--text-muted));
    background: var(--bg-page);
    border: 1px solid var(--border);
    border-radius: 999px;
    padding: 0.08rem 0.45rem;
}
.group-chevron {
    margin-left: auto;
    color: var(--text-muted);
    flex-shrink: 0;
}
</style>

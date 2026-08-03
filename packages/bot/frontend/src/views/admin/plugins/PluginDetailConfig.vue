<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Icon } from '@iconify/vue';
import { AppBadge } from '@karyl-chan/ui';
import {
    setPluginConfig,
    getPluginSettings,
    type PluginDetailRecord,
    type PluginSettings,
} from '../../../api/plugins';
import PluginConfigFields from '../../../components/PluginConfigFields.vue';
import { fromPluginConfigPayload, usePluginConfigEditor } from '../../../composables/use-plugin-config-editor';
import { formatBytes } from '../../../utils/format';

const props = defineProps<{
    plugin: PluginDetailRecord;
}>();

const { t } = useI18n();

const manifest = computed(() => props.plugin.manifest);
const hasConfigSchema = computed(() => (manifest.value?.config_schema?.length ?? 0) > 0);

// ─── One settings fetch drives both the config editor and the overview ─
const loading = ref(false);
const loadError = ref<string | null>(null);
const loaded = ref(false);
const summary = ref<PluginSettings | null>(null);

// Config editor state (operator-owned, global). PD-2.2. Seeding, drift
// detection and 422 mapping live in the composable (#31); the fetch stays
// here because one request feeds both the editor and the overview below.
const {
    fields: configSchema,
    values: configValues,
    fieldErrors: configFieldErrors,
    stale: configStale,
    saving: configSaving,
    saved: configSaved,
    error: configError, // save-time error only; the fetch has its own
    invalidCount: configInvalidCount,
    apply: applyConfig,
    reset: resetConfigEditor,
    save: saveConfig,
} = usePluginConfigEditor({
    save: (values) => setPluginConfig(props.plugin.id, values),
});

const features = computed(() => manifest.value?.guild_features ?? []);

/** Guilds that have at least one feature override, each with a per-feature
 *  map for the matrix. Sorted by guildId for a stable table. */
const overrideRows = computed(() => {
    const byGuild = new Map<string, Map<string, boolean>>();
    for (const o of summary.value?.featureOverrides ?? []) {
        let m = byGuild.get(o.guildId);
        if (!m) {
            m = new Map();
            byGuild.set(o.guildId, m);
        }
        m.set(o.featureKey, o.enabled);
    }
    return [...byGuild.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([guildId, feats]) => ({ guildId, feats }));
});

/** Matrix columns: manifest features first, then any override keys no
 *  longer in the manifest ("orphans") so a lingering override for a removed
 *  feature stays visible instead of collapsing to an all-"—" row — it still
 *  affects feature-reach resolution. */
const columns = computed(() => {
    const manifestKeys = new Set(features.value.map((f) => f.key));
    const cols = features.value.map((f) => ({ key: f.key, name: f.name, orphan: false }));
    const orphans = new Set<string>();
    for (const o of summary.value?.featureOverrides ?? []) {
        if (!manifestKeys.has(o.featureKey)) orphans.add(o.featureKey);
    }
    for (const k of [...orphans].sort()) cols.push({ key: k, name: k, orphan: true });
    return cols;
});

const kvGuilds = computed(() => summary.value?.kv.guilds ?? []);
const kvQuota = computed(() => summary.value?.kv.quotaBytes ?? 0);
function kvPct(used: number): number {
    if (kvQuota.value <= 0) return 0;
    return Math.min(100, Math.round((used / kvQuota.value) * 100));
}

async function load() {
    if (loading.value) return;
    loading.value = true;
    loadError.value = null;
    const requestedId = props.plugin.id;
    try {
        const r = await getPluginSettings(requestedId);
        if (props.plugin.id !== requestedId) return;
        applyConfig(fromPluginConfigPayload(r.config));
        summary.value = r;
        loaded.value = true;
    } catch (err) {
        if (props.plugin.id !== requestedId) return;
        loadError.value = err instanceof Error ? err.message : String(err);
    } finally {
        if (props.plugin.id === requestedId) loading.value = false;
    }
}

function resetState(): void {
    resetConfigEditor();
    summary.value = null;
    loaded.value = false;
}

watch(
    () => props.plugin.id,
    (id, oldId) => {
        if (id === oldId) return;
        resetState();
        load();
    },
);

onMounted(load);
</script>

<template>
    <div class="tab-panel">
        <p v-if="loading" class="muted">{{ t('common.loading') }}</p>
        <p v-else-if="loadError" class="error" role="alert">{{ loadError }}</p>
        <template v-else>
            <!-- 1. Plugin config (operator-owned, global) -->
            <section v-if="hasConfigSchema" class="section config-section">
                <div class="section-header">
                    <h3 class="section-title">{{ t('admin.plugins.detail.config.pluginConfigTitle') }}</h3>
                    <AppBadge v-if="configSaved" tone="success" size="sm">
                        {{ t('admin.plugins.detail.config.saved') }}
                    </AppBadge>
                </div>
                <div v-if="configStale" class="config-stale-warning" role="alert">
                    <Icon icon="material-symbols:warning-outline-rounded" width="16" height="16" class="stale-icon" />
                    <span>{{ t('admin.plugins.detail.configStale') }}</span>
                </div>
                <p v-if="configError" class="error" role="alert">{{ configError }}</p>
                <p v-else-if="configInvalidCount > 0" class="error" role="alert">
                    {{ t('admin.plugins.configFieldErrors', { n: configInvalidCount }) }}
                </p>
                <PluginConfigFields
                    :schema="configSchema"
                    :values="configValues"
                    :field-errors="configFieldErrors"
                    layout="grid"
                />
                <div class="config-actions">
                    <button type="button" class="primary" :disabled="configSaving" @click="saveConfig">
                        {{ configSaving ? t('admin.plugins.detail.config.saving') : t('admin.plugins.detail.config.save') }}
                    </button>
                </div>
            </section>

            <!-- 2. Per-guild feature overrides matrix -->
            <section v-if="columns.length > 0" class="section">
                <div class="section-header">
                    <h3 class="section-title">{{ t('admin.plugins.detail.config.guildOverridesTitle') }}</h3>
                </div>
                <p class="section-desc">{{ t('admin.plugins.detail.config.guildOverridesDesc') }}</p>
                <p v-if="overrideRows.length === 0" class="muted">
                    {{ t('admin.plugins.detail.config.noOverrides') }}
                </p>
                <div v-else class="matrix-scroll">
                    <table class="matrix">
                        <thead>
                            <tr>
                                <th>{{ t('admin.plugins.detail.config.guildCol') }}</th>
                                <th
                                    v-for="c in columns"
                                    :key="c.key"
                                    :class="{ orphan: c.orphan }"
                                    :title="c.orphan ? t('admin.plugins.detail.config.featureRemoved') : c.key"
                                >{{ c.name }}<span v-if="c.orphan" class="orphan-mark" aria-hidden="true"> ⚠</span></th>
                            </tr>
                        </thead>
                        <tbody>
                            <tr v-for="row in overrideRows" :key="row.guildId">
                                <td>
                                    <span v-if="summary?.guildNames[row.guildId]" class="gname" :title="row.guildId">{{ summary.guildNames[row.guildId] }}</span>
                                    <code v-else class="gid">{{ row.guildId }}</code>
                                </td>
                                <td v-for="c in columns" :key="c.key" class="cell">
                                    <span
                                        v-if="row.feats.has(c.key)"
                                        :class="['ov', row.feats.get(c.key) ? 'on' : 'off']"
                                        :title="row.feats.get(c.key) ? t('admin.plugins.detail.config.overrideOn') : t('admin.plugins.detail.config.overrideOff')"
                                    >{{ row.feats.get(c.key) ? '✓' : '✕' }}</span>
                                    <span v-else class="ov default" :title="t('admin.plugins.detail.config.usingDefault')">—</span>
                                </td>
                            </tr>
                        </tbody>
                    </table>
                </div>
            </section>

            <!-- 3. KV usage (plugin-owned: usage/quota only, content NOT shown) -->
            <section class="section">
                <div class="section-header">
                    <h3 class="section-title">{{ t('admin.plugins.detail.config.kvTitle') }}</h3>
                </div>
                <p class="section-desc">{{ t('admin.plugins.detail.config.kvDesc') }}</p>
                <p v-if="kvGuilds.length === 0" class="muted">
                    {{ t('admin.plugins.detail.config.kvEmpty') }}
                </p>
                <ul v-else class="kv-list">
                    <li v-for="g in kvGuilds" :key="g.guildId" class="kv-row">
                        <span v-if="summary?.guildNames[g.guildId]" class="gname" :title="g.guildId">{{ summary.guildNames[g.guildId] }}</span>
                        <code v-else class="gid">{{ g.guildId }}</code>
                        <div class="kv-bar"><div class="kv-fill" :style="{ width: kvPct(g.usedBytes) + '%' }" /></div>
                        <span class="kv-num">
                            {{ t('admin.plugins.detail.config.kvKeys', { n: g.keyCount }) }} ·
                            {{ formatBytes(g.usedBytes) }} / {{ formatBytes(kvQuota) }}
                        </span>
                    </li>
                </ul>
            </section>
        </template>
    </div>
</template>

<style scoped>
.tab-panel {
    display: flex;
    flex-direction: column;
    gap: 1rem;
    padding: 0.5rem 0;
}
.section {
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-base);
    padding: 0.8rem 1rem;
}
.section-header {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    margin-bottom: 0.5rem;
}
.section-title {
    margin: 0;
    font-size: 0.92rem;
    font-weight: 600;
    color: var(--text-strong);
    flex: 1;
}
.section-desc { margin: 0 0 0.6rem; font-size: 0.83rem; color: var(--text-muted); line-height: 1.5; }
.muted { color: var(--text-muted); font-size: 0.85rem; }
.error { color: var(--danger); margin: 0; font-size: 0.85rem; }
.gid { font-family: var(--font-mono, monospace); font-size: 0.76rem; color: var(--text); }
.gname { font-size: 0.83rem; color: var(--text); font-weight: 500; }

/* config editor (moved from Overview) */
.config-section { margin-top: 0; }
.config-stale-warning {
    display: flex;
    align-items: flex-start;
    gap: 0.4rem;
    padding: 0.55rem 0.8rem;
    margin-bottom: 0.6rem;
    background: color-mix(in srgb, var(--warning, #d97706) 11%, var(--bg-surface));
    border: 1px solid color-mix(in srgb, var(--warning, #d97706) 35%, transparent);
    border-radius: var(--radius-sm);
    font-size: 0.83rem;
    line-height: 1.5;
    color: var(--warning, #d97706);
}
.config-stale-warning .stale-icon { flex-shrink: 0; margin-top: 0.1rem; }
.config-actions { display: flex; justify-content: flex-end; margin-top: 0.6rem; }
.config-actions .primary {
    padding: 0.4rem 0.85rem;
    background: var(--accent);
    color: var(--text-on-accent);
    border: none;
    border-radius: var(--radius-sm);
    cursor: pointer;
    font-size: 0.85rem;
}
.config-actions .primary:disabled { opacity: 0.55; cursor: not-allowed; }

/* per-guild feature matrix */
.matrix-scroll { overflow-x: auto; }
.matrix { border-collapse: collapse; font-size: 0.82rem; width: 100%; }
.matrix th, .matrix td {
    padding: 0.3rem 0.5rem;
    border-bottom: 1px solid var(--border);
    text-align: left;
    white-space: nowrap;
}
.matrix th { color: var(--text-muted); font-weight: 500; }
.matrix th.orphan { color: var(--warning, #d97706); }
.orphan-mark { color: var(--warning, #d97706); }
.matrix .cell { text-align: center; }
.ov { font-weight: 600; }
.ov.on { color: var(--success, #16a34a); }
.ov.off { color: var(--danger, #dc2626); }
.ov.default { color: var(--text-muted); }

/* KV usage */
.kv-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.45rem; }
.kv-row { display: grid; grid-template-columns: minmax(8rem, max-content) 1fr max-content; align-items: center; gap: 0.6rem; }
.kv-bar { height: 0.5rem; background: var(--bg-page); border: 1px solid var(--border); border-radius: 999px; overflow: hidden; }
.kv-fill { height: 100%; background: var(--accent); }
.kv-num { font-size: 0.78rem; color: var(--text-muted); font-variant-numeric: tabular-nums; white-space: nowrap; }
</style>

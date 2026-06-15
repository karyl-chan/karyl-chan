<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Icon } from '@iconify/vue';
import { AppBadge } from '@karyl-chan/ui';
import {
    ConfigValidationError,
    setPluginConfig,
    getPluginSettings,
    type PluginConfigField,
    type PluginDetailRecord,
    type PluginSettings,
} from '../../../api/plugins';
import PluginConfigFields from '../../../components/PluginConfigFields.vue';
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

// Config editor state (operator-owned, global). PD-2.2.
const configSchema = ref<PluginConfigField[]>([]);
const configValues = reactive<Record<string, string>>({});
const configSaving = ref(false);
const configError = ref<string | null>(null); // save-time error only
const configSavedAt = ref<number | null>(null);
// PD-4.3: stored admin config saved under an older config_schema_version.
const configStale = ref(false);
const configFieldErrors = reactive<Record<string, string>>({});
function clearFieldErrors(): void {
    for (const k of Object.keys(configFieldErrors)) delete configFieldErrors[k];
}

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

const kvGuilds = computed(() => summary.value?.kv.guilds ?? []);
const kvQuota = computed(() => summary.value?.kv.quotaBytes ?? 0);
function kvPct(used: number): number {
    if (kvQuota.value <= 0) return 0;
    return Math.min(100, Math.round((used / kvQuota.value) * 100));
}

/** Seed the editor from the fetched config payload. Values are stored as
 *  strings keyed by field; defaults arrive as raw manifest JSON. */
function applyConfig(config: PluginSettings['config']): void {
    configSchema.value = config.schema;
    configStale.value =
        config.storedConfigSchemaVersion != null &&
        config.configSchemaVersion != null &&
        config.storedConfigSchemaVersion < config.configSchemaVersion;
    for (const k of Object.keys(configValues)) delete configValues[k];
    for (const v of config.values) configValues[v.key] = v.value ?? '';
    for (const f of config.schema) {
        if (!(f.key in configValues)) {
            const raw = f.default;
            configValues[f.key] =
                f.type === 'boolean'
                    ? raw === true || raw === 'true'
                        ? 'true'
                        : 'false'
                    : raw == null
                      ? ''
                      : String(raw);
        }
    }
}

async function load() {
    if (loading.value) return;
    loading.value = true;
    loadError.value = null;
    const requestedId = props.plugin.id;
    try {
        const r = await getPluginSettings(requestedId);
        if (props.plugin.id !== requestedId) return;
        applyConfig(r.config);
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
    for (const k of Object.keys(configValues)) delete configValues[k];
    configSchema.value = [];
    clearFieldErrors();
    configError.value = null;
    configSavedAt.value = null;
    configStale.value = false;
    summary.value = null;
    loaded.value = false;
}

async function saveConfig() {
    if (configSaving.value) return;
    configSaving.value = true;
    configError.value = null;
    clearFieldErrors();
    try {
        await setPluginConfig(props.plugin.id, { ...configValues });
        configSavedAt.value = Date.now();
        configStale.value = false;
    } catch (err) {
        if (err instanceof ConfigValidationError) {
            for (const fe of err.fieldErrors) {
                configFieldErrors[fe.key] = fe.message;
            }
            configError.value =
                err.fieldErrors.length === 1
                    ? `1 field has errors — correct it and save again.`
                    : `${err.fieldErrors.length} fields have errors — correct them and save again.`;
        } else {
            configError.value = err instanceof Error ? err.message : String(err);
        }
    } finally {
        configSaving.value = false;
    }
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
                    <AppBadge v-if="configSavedAt && (Date.now() - configSavedAt < 4000)" tone="success" size="sm">
                        {{ t('admin.plugins.detail.config.saved') }}
                    </AppBadge>
                </div>
                <div v-if="configStale" class="config-stale-warning" role="alert">
                    <Icon icon="material-symbols:warning-outline-rounded" width="16" height="16" class="stale-icon" />
                    <span>{{ t('admin.plugins.detail.configStale') }}</span>
                </div>
                <p v-if="configError" class="error" role="alert">{{ configError }}</p>
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
            <section v-if="features.length > 0" class="section">
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
                                <th v-for="f in features" :key="f.key" :title="f.key">{{ f.name }}</th>
                            </tr>
                        </thead>
                        <tbody>
                            <tr v-for="row in overrideRows" :key="row.guildId">
                                <td>
                                    <span v-if="summary?.guildNames[row.guildId]" class="gname" :title="row.guildId">{{ summary.guildNames[row.guildId] }}</span>
                                    <code v-else class="gid">{{ row.guildId }}</code>
                                </td>
                                <td v-for="f in features" :key="f.key" class="cell">
                                    <span
                                        v-if="row.feats.has(f.key)"
                                        :class="['ov', row.feats.get(f.key) ? 'on' : 'off']"
                                        :title="row.feats.get(f.key) ? t('admin.plugins.detail.config.overrideOn') : t('admin.plugins.detail.config.overrideOff')"
                                    >{{ row.feats.get(f.key) ? '✓' : '✕' }}</span>
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

<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Icon } from '@iconify/vue';
import { AppBadge } from '@karyl-chan/ui';
import {
    ConfigValidationError,
    getPluginConfig,
    setPluginConfig,
    getPluginSettingsSummary,
    type PluginConfigField,
    type PluginDetailRecord,
    type PluginSettingsSummary,
} from '../../../api/plugins';

const props = defineProps<{
    plugin: PluginDetailRecord;
}>();

const { t } = useI18n();

const manifest = computed(() => props.plugin.manifest);
const hasConfigSchema = computed(() => (manifest.value?.config_schema?.length ?? 0) > 0);

// ─── Plugin config editor (moved from Overview, PD-2.2) ───────────────
const configSchema = ref<PluginConfigField[]>([]);
const configValues = reactive<Record<string, string>>({});
const configLoaded = ref(false);
const configLoading = ref(false);
const configSaving = ref(false);
const configError = ref<string | null>(null);
const configSavedAt = ref<number | null>(null);
// PD-4.3: stored admin config saved under an older config_schema_version.
const configStale = ref(false);
const configFieldErrors = reactive<Record<string, string>>({});
function fieldErrorFor(key: string): string | null {
    return configFieldErrors[key] ?? null;
}
function clearFieldErrors(): void {
    for (const k of Object.keys(configFieldErrors)) delete configFieldErrors[k];
}

function resetConfigState(): void {
    for (const k of Object.keys(configValues)) delete configValues[k];
    configSchema.value = [];
    clearFieldErrors();
    configError.value = null;
    configSavedAt.value = null;
    configLoaded.value = false;
}

async function loadConfig() {
    if (configLoaded.value || configLoading.value) return;
    configLoading.value = true;
    configError.value = null;
    const requestedId = props.plugin.id;
    try {
        const r = await getPluginConfig(requestedId);
        if (props.plugin.id !== requestedId) return;
        configSchema.value = r.schema;
        configStale.value =
            r.storedConfigSchemaVersion != null &&
            r.configSchemaVersion != null &&
            r.storedConfigSchemaVersion < r.configSchemaVersion;
        for (const v of r.values) {
            configValues[v.key] = v.value ?? '';
        }
        for (const f of r.schema) {
            if (!(f.key in configValues)) {
                configValues[f.key] = (f.default as string | undefined) ?? '';
            }
        }
        configLoaded.value = true;
    } catch (err) {
        if (props.plugin.id !== requestedId) return;
        configError.value = err instanceof Error ? err.message : String(err);
    } finally {
        if (props.plugin.id === requestedId) {
            configLoading.value = false;
        }
    }
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

// ─── Cross-surface summary: per-guild feature overrides + KV usage ────
const summary = ref<PluginSettingsSummary | null>(null);
const summaryLoading = ref(false);
const summaryError = ref<string | null>(null);

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

function fmtBytes(n: number): string {
    if (n < 1024) return `${n} B`;
    return `${(n / 1024).toFixed(1)} KB`;
}
function kvPct(used: number): number {
    if (kvQuota.value <= 0) return 0;
    return Math.min(100, Math.round((used / kvQuota.value) * 100));
}

async function loadSummary() {
    if (summaryLoading.value) return;
    summaryLoading.value = true;
    summaryError.value = null;
    const requestedId = props.plugin.id;
    try {
        const r = await getPluginSettingsSummary(requestedId);
        if (props.plugin.id !== requestedId) return;
        summary.value = r;
    } catch (err) {
        if (props.plugin.id !== requestedId) return;
        summaryError.value = err instanceof Error ? err.message : String(err);
    } finally {
        if (props.plugin.id === requestedId) summaryLoading.value = false;
    }
}

function loadAll() {
    if (hasConfigSchema.value) void loadConfig();
    void loadSummary();
}

watch(
    () => props.plugin.id,
    (id, oldId) => {
        if (id === oldId) return;
        resetConfigState();
        summary.value = null;
        loadAll();
    },
);

onMounted(loadAll);
</script>

<template>
    <div class="tab-panel">
        <!-- 1. Plugin config (operator-owned, global) -->
        <section v-if="hasConfigSchema" class="section config-section">
            <div class="section-header">
                <h3 class="section-title">{{ t('admin.plugins.detail.config.pluginConfigTitle') }}</h3>
                <AppBadge v-if="configSavedAt && (Date.now() - configSavedAt < 4000)" tone="success" size="sm">
                    {{ t('admin.plugins.detail.config.saved') }}
                </AppBadge>
            </div>
            <div v-if="configStale && configLoaded" class="config-stale-warning" role="alert">
                <Icon icon="material-symbols:warning-outline-rounded" width="16" height="16" class="stale-icon" />
                <span>{{ t('admin.plugins.detail.configStale') }}</span>
            </div>
            <p v-if="configLoading" class="muted">{{ t('common.loading') }}</p>
            <p v-if="configError" class="error" role="alert">{{ configError }}</p>
            <div v-else-if="configLoaded" class="config-grid">
                <label
                    v-for="field in configSchema"
                    :key="field.key"
                    :class="[
                        'config-field',
                        { full: field.type === 'textarea', 'has-error': fieldErrorFor(field.key) !== null },
                    ]"
                >
                    <span class="config-label">
                        {{ field.label }}
                        <span v-if="field.required" class="req" aria-hidden="true">*</span>
                        <span v-if="field.description" class="hint">{{ field.description }}</span>
                    </span>
                    <textarea
                        v-if="field.type === 'textarea'"
                        v-model="configValues[field.key]"
                        rows="3"
                        spellcheck="false"
                        :maxlength="field.max"
                    />
                    <select
                        v-else-if="field.type === 'select' && field.options"
                        v-model="configValues[field.key]"
                    >
                        <option value="">—</option>
                        <option v-for="opt in field.options" :key="opt.value" :value="opt.value">
                            {{ opt.label }}
                        </option>
                    </select>
                    <input
                        v-else-if="field.type === 'boolean'"
                        type="checkbox"
                        :checked="configValues[field.key] === 'true'"
                        @change="(e) => { configValues[field.key] = (e.target as HTMLInputElement).checked ? 'true' : 'false'; }"
                    />
                    <input
                        v-else
                        v-model="configValues[field.key]"
                        :type="field.type === 'secret' ? 'password' : (field.type === 'number' ? 'number' : 'text')"
                        :placeholder="field.type === 'secret' ? '留空 = 不變更' : ''"
                        autocomplete="off"
                        spellcheck="false"
                        :min="field.type === 'number' ? field.min : undefined"
                        :max="field.type === 'number' ? field.max : undefined"
                        :step="field.type === 'number' ? field.step : undefined"
                        :maxlength="field.type !== 'number' ? field.max : undefined"
                        :pattern="field.pattern"
                    />
                    <span
                        v-if="fieldErrorFor(field.key)"
                        class="field-error"
                        role="alert"
                    >{{ fieldErrorFor(field.key) }}</span>
                </label>
                <div class="config-actions">
                    <button type="button" class="primary" :disabled="configSaving" @click="saveConfig">
                        {{ configSaving ? t('admin.plugins.detail.config.saving') : t('admin.plugins.detail.config.save') }}
                    </button>
                </div>
            </div>
        </section>

        <!-- 2. Per-guild feature overrides matrix -->
        <section v-if="features.length > 0" class="section">
            <div class="section-header">
                <h3 class="section-title">{{ t('admin.plugins.detail.config.guildOverridesTitle') }}</h3>
            </div>
            <p class="section-desc">{{ t('admin.plugins.detail.config.guildOverridesDesc') }}</p>
            <p v-if="summaryLoading" class="muted">{{ t('common.loading') }}</p>
            <p v-else-if="summaryError" class="error" role="alert">{{ summaryError }}</p>
            <p v-else-if="overrideRows.length === 0" class="muted">
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
                            <td><code class="gid">{{ row.guildId }}</code></td>
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
            <p v-if="summaryLoading" class="muted">{{ t('common.loading') }}</p>
            <p v-else-if="kvGuilds.length === 0" class="muted">
                {{ t('admin.plugins.detail.config.kvEmpty') }}
            </p>
            <ul v-else class="kv-list">
                <li v-for="g in kvGuilds" :key="g.guildId" class="kv-row">
                    <code class="gid">{{ g.guildId }}</code>
                    <div class="kv-bar"><div class="kv-fill" :style="{ width: kvPct(g.usedBytes) + '%' }" /></div>
                    <span class="kv-num">
                        {{ t('admin.plugins.detail.config.kvKeys', { n: g.keyCount }) }} ·
                        {{ fmtBytes(g.usedBytes) }} / {{ fmtBytes(kvQuota) }}
                    </span>
                </li>
            </ul>
        </section>
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
.config-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
    gap: 0.6rem 0.85rem;
}
.config-field { display: flex; flex-direction: column; gap: 0.25rem; }
.config-field.full { grid-column: 1 / -1; }
.config-label {
    display: flex; flex-direction: column;
    font-size: 0.82rem;
    color: var(--text-strong);
    font-weight: 500;
}
.config-label .req { color: var(--danger); margin-left: 0.2rem; font-weight: 400; }
.config-label .hint { color: var(--text-muted); font-weight: 400; font-size: 0.75rem; margin-top: 0.1rem; }
.config-field input[type="text"],
.config-field input[type="number"],
.config-field input[type="password"],
.config-field textarea,
.config-field select {
    padding: 0.35rem 0.5rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg-surface);
    color: var(--text);
    font-size: 0.85rem;
    font-family: inherit;
}
.config-field.has-error input,
.config-field.has-error textarea,
.config-field.has-error select { border-color: var(--danger); }
.field-error { color: var(--danger); font-size: 0.78rem; margin-top: 0.2rem; }
.config-field input[type="checkbox"] { align-self: flex-start; margin-top: 0.2rem; }
.config-actions { grid-column: 1 / -1; display: flex; justify-content: flex-end; }
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

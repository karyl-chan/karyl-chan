<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Icon } from '@iconify/vue';
import { AppBadge, type BadgeTone } from '@karyl-chan/ui';
import {
    ConfigValidationError,
    getPluginConfig,
    setPluginConfig,
    type FieldValidationError,
    type PluginConfigField,
    type PluginDetailRecord,
} from '../../../api/plugins';
import { safeHref } from '../../../libs/messages/safe-href';

const props = defineProps<{
    plugin: PluginDetailRecord;
}>();

const { t } = useI18n();

const manifest = computed(() => props.plugin.manifest);
const hasConfigSchema = computed(() => (manifest.value?.config_schema?.length ?? 0) > 0);

// Workpack C: health + metrics inline on the overview tab.
const health = computed(() => props.plugin.health ?? null);

function healthTone(status: string | undefined): BadgeTone {
    if (status === 'healthy') return 'success';
    if (status === 'degraded') return 'warn';
    if (status === 'unhealthy') return 'danger';
    return 'neutral';
}
const metrics = computed(() => props.plugin.metrics ?? null);
const hasMetrics = computed(() => {
    const m = metrics.value;
    if (!m) return false;
    return m.counters.length > 0 || m.gauges.length > 0 || m.histograms.length > 0;
});

function formatLabels(labels: Record<string, string>): string {
    const entries = Object.entries(labels);
    if (entries.length === 0) return '';
    return entries.map(([k, v]) => `${k}=${v}`).join(', ');
}
function formatAge(unixMs: number): string {
    const seconds = Math.max(0, Math.floor((Date.now() - unixMs) / 1000));
    if (seconds < 60) return `${seconds}s ago`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    return `${Math.floor(seconds / 3600)}h ago`;
}

// Config editor (same lazy-load pattern as PluginCard)
const configSchema = ref<PluginConfigField[]>([]);
const configValues = reactive<Record<string, string>>({});
const configLoaded = ref(false);
const configLoading = ref(false);
const configSaving = ref(false);
const configError = ref<string | null>(null);
const configSavedAt = ref<number | null>(null);
// Workpack D: per-field validation errors from the most recent save
// attempt. Keyed by field key; populated from a 422 ConfigValidationError.
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
    // Capture the plugin id at load time. The user might switch to
    // another plugin while the fetch is in flight; the late response
    // must not splat A's values onto B's editor.
    const requestedId = props.plugin.id;
    try {
        const r = await getPluginConfig(requestedId);
        if (props.plugin.id !== requestedId) return;
        configSchema.value = r.schema;
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
        // Plugin switched while this component stayed mounted (e.g.
        // navigating between two plugin detail routes). Drop the
        // previous plugin's reactive config map outright — otherwise a
        // subsequent save would PUT plugin A's values into plugin B.
        resetConfigState();
        if (hasConfigSchema.value) void loadConfig();
    },
);

onMounted(() => {
    if (hasConfigSchema.value) void loadConfig();
});
</script>

<template>
    <div class="tab-panel">
        <!-- Meta grid -->
        <section class="section">
            <dl class="meta">
                <div class="meta-row">
                    <dt>{{ t('admin.plugins.detail.overviewMeta.pluginKey') }}</dt>
                    <dd><code>{{ plugin.pluginKey }}</code></dd>
                </div>
                <div class="meta-row">
                    <dt>{{ t('admin.plugins.url') }}</dt>
                    <dd><code>{{ plugin.url }}</code></dd>
                </div>
                <div v-if="manifest?.plugin.author" class="meta-row">
                    <dt>{{ t('admin.plugins.detail.overviewMeta.author') }}</dt>
                    <dd>{{ manifest.plugin.author }}</dd>
                </div>
                <div v-if="manifest?.plugin.homepage" class="meta-row">
                    <dt>{{ t('admin.plugins.detail.overviewMeta.homepage') }}</dt>
                    <dd>
                        <a :href="safeHref(manifest.plugin.homepage)" target="_blank" rel="noopener noreferrer" class="link">
                            {{ manifest.plugin.homepage }}
                        </a>
                    </dd>
                </div>
                <div class="meta-row">
                    <dt>{{ t('admin.plugins.lastHeartbeat') }}</dt>
                    <dd>{{ plugin.lastHeartbeatAt ?? t('admin.plugins.neverHeartbeat') }}</dd>
                </div>
            </dl>
        </section>

        <!-- Workpack C: health probe result -->
        <section v-if="health" class="section">
            <div class="section-header">
                <h3 class="section-title">健康狀態</h3>
                <span class="muted health-age">{{ formatAge(health.checkedAt) }}</span>
            </div>
            <div class="health-row">
                <AppBadge :tone="healthTone(health.status)">{{ health.status }}</AppBadge>
                <span v-if="health.message" class="health-msg">{{ health.message }}</span>
            </div>
            <ul v-if="health.checks && health.checks.length > 0" class="health-checks">
                <li v-for="c in health.checks" :key="c.name" class="health-check">
                    <span :class="['health-dot', `status-${c.status}`]" aria-hidden="true" />
                    <code class="check-name">{{ c.name }}</code>
                    <span v-if="c.message" class="check-msg">{{ c.message }}</span>
                </li>
            </ul>
        </section>

        <!-- Workpack C: metrics snapshot -->
        <section v-if="hasMetrics && metrics" class="section">
            <div class="section-header">
                <h3 class="section-title">指標</h3>
                <span class="muted health-age">{{ formatAge(metrics.receivedAt) }}</span>
            </div>
            <div v-if="metrics.counters.length > 0" class="metrics-block">
                <h4 class="metrics-subhead">Counters</h4>
                <table class="metrics-table">
                    <tr v-for="(c, i) in metrics.counters" :key="`c-${i}`">
                        <td class="metric-name"><code>{{ c.name }}</code></td>
                        <td class="metric-labels muted">{{ formatLabels(c.labels) }}</td>
                        <td class="metric-value">{{ c.value }}</td>
                    </tr>
                </table>
            </div>
            <div v-if="metrics.gauges.length > 0" class="metrics-block">
                <h4 class="metrics-subhead">Gauges</h4>
                <table class="metrics-table">
                    <tr v-for="(g, i) in metrics.gauges" :key="`g-${i}`">
                        <td class="metric-name"><code>{{ g.name }}</code></td>
                        <td class="metric-labels muted">{{ formatLabels(g.labels) }}</td>
                        <td class="metric-value">{{ g.value }}</td>
                    </tr>
                </table>
            </div>
            <div v-if="metrics.histograms.length > 0" class="metrics-block">
                <h4 class="metrics-subhead">Histograms</h4>
                <table class="metrics-table">
                    <thead>
                        <tr><th>name</th><th>labels</th><th>count</th><th>p50</th><th>p95</th><th>p99</th></tr>
                    </thead>
                    <tr v-for="(h, i) in metrics.histograms" :key="`h-${i}`">
                        <td class="metric-name"><code>{{ h.name }}</code></td>
                        <td class="metric-labels muted">{{ formatLabels(h.labels) }}</td>
                        <td class="metric-value">{{ h.count }}</td>
                        <td class="metric-value">{{ h.p50.toFixed(2) }}</td>
                        <td class="metric-value">{{ h.p95.toFixed(2) }}</td>
                        <td class="metric-value">{{ h.p99.toFixed(2) }}</td>
                    </tr>
                </table>
            </div>
        </section>

        <!-- Granted RPC methods (read-only — manifest's rpc_methods_used) -->
        <section v-if="(manifest?.rpc_methods_used?.length ?? 0) > 0" class="section">
            <h3 class="section-title">{{ t('admin.plugins.rpcScopes') }}</h3>
            <div class="chip-row">
                <AppBadge v-for="m in (manifest?.rpc_methods_used ?? [])" :key="m" variant="outline" mono>{{ m }}</AppBadge>
            </div>
        </section>

        <!-- Config editor -->
        <section v-if="hasConfigSchema" class="section config-section">
            <div class="section-header">
                <h3 class="section-title">外掛設定</h3>
                <AppBadge v-if="configSavedAt && (Date.now() - configSavedAt < 4000)" tone="success" size="sm">已儲存</AppBadge>
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
                        {{ configSaving ? '儲存中…' : '儲存設定' }}
                    </button>
                </div>
            </div>
        </section>

        <!-- Raw manifest -->
        <details v-if="manifest" class="manifest-fold">
            <summary>{{ t('admin.plugins.manifestRaw') }}</summary>
            <pre>{{ JSON.stringify(manifest, null, 2) }}</pre>
        </details>
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
    margin-bottom: 0.75rem;
}
.section-title {
    margin: 0;
    font-size: 0.92rem;
    font-weight: 600;
    color: var(--text-strong);
    flex: 1;
}
.meta {
    margin: 0;
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 0.35rem 0.75rem;
    font-size: 0.85rem;
}
.meta-row { display: contents; }
.meta dt { color: var(--text-muted); }
.meta dd { margin: 0; color: var(--text); }
.meta code {
    font-family: var(--font-mono, monospace);
    font-size: 0.78rem;
    background: var(--bg-page);
    padding: 0.1rem 0.35rem;
    border-radius: var(--radius-sm);
}
.link { color: var(--accent); text-decoration: none; }
.link:hover { text-decoration: underline; }

.chip-row { display: flex; flex-wrap: wrap; gap: 0.3rem; margin-top: 0.5rem; }

.config-section { margin-top: 0; }
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
.config-field.has-error input[type="text"],
.config-field.has-error input[type="number"],
.config-field.has-error input[type="password"],
.config-field.has-error textarea,
.config-field.has-error select {
    border-color: var(--danger);
}
.field-error {
    color: var(--danger);
    font-size: 0.78rem;
    margin-top: 0.2rem;
}
.config-field input[type="checkbox"] { align-self: flex-start; margin-top: 0.2rem; }
.config-actions {
    grid-column: 1 / -1;
    display: flex; justify-content: flex-end;
}
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

.manifest-fold summary { cursor: pointer; color: var(--text-muted); font-size: 0.85rem; }
.manifest-fold pre {
    margin-top: 0.4rem;
    padding: 0.5rem;
    background: var(--bg-page);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    font-size: 0.75rem;
    overflow: auto;
    max-height: 24rem;
    color: var(--text);
}
.muted { color: var(--text-muted); font-size: 0.85rem; }
.error { color: var(--danger); margin: 0; font-size: 0.85rem; }

/* Workpack C — health + metrics blocks */
.health-age { font-size: 0.75rem; color: var(--text-muted); }
.health-row { display: flex; align-items: center; gap: 0.6rem; }
.health-msg { color: var(--text-muted); font-size: 0.85rem; }
.health-checks {
    list-style: none;
    margin: 0.6rem 0 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
}
.health-check { display: flex; align-items: center; gap: 0.45rem; font-size: 0.82rem; }
.health-dot {
    width: 0.55rem; height: 0.55rem;
    border-radius: 50%;
    background: var(--text-muted);
    flex-shrink: 0;
}
.health-dot.status-healthy { background: rgb(34, 197, 94); }
.health-dot.status-degraded { background: rgb(234, 179, 8); }
.health-dot.status-unhealthy { background: rgb(239, 68, 68); }
.check-name { font-family: var(--font-mono, monospace); font-size: 0.75rem; }
.check-msg { color: var(--text-muted); }

.metrics-block { margin-top: 0.5rem; }
.metrics-block:first-child { margin-top: 0; }
.metrics-subhead {
    font-size: 0.78rem;
    font-weight: 600;
    margin: 0.7rem 0 0.3rem;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.06em;
}
.metrics-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.82rem;
}
.metrics-table th {
    text-align: left;
    font-weight: 500;
    color: var(--text-muted);
    padding: 0.2rem 0.4rem;
    border-bottom: 1px solid var(--border);
}
.metrics-table td {
    padding: 0.2rem 0.4rem;
    border-bottom: 1px solid var(--border);
}
.metric-name code {
    font-family: var(--font-mono, monospace);
    font-size: 0.76rem;
}
.metric-labels { font-size: 0.75rem; }
.metric-value { font-variant-numeric: tabular-nums; text-align: right; }
</style>

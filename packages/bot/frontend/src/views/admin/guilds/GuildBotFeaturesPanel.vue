<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { Icon } from '@iconify/vue';
import { useI18n } from 'vue-i18n';
import { AppConfirmDialog, AppToggle } from '@karyl-chan/ui';
import {
    clearGuildFeatureOverride,
    listGuildFeatures,
    setGuildFeatureConfig,
    setGuildFeatureEnabled,
    type GuildFeatureItem
} from '../../../api/plugin-features';
import { ConfigValidationError } from '../../../api/plugins';
import {
    listBuiltinFeatureState,
    setBuiltinFeatureState,
    type BuiltinFeatureState
} from '../../../api/builtin-features';
import { guildFeatures as builtinRegistry } from '../../../modules/guild-features/registry';
import { useApiError } from '../../../composables/use-api-error';

/**
 * Per-guild Bot Features panel. Lists every built-in (in-process) +
 * plugin-provided guild feature with a single on/off switch per row
 * scoped to this guild.
 *
 *   Built-in: per-guild row falls back to operator default (set in
 *             "All Servers" → Bot 功能) → built-ins default ON.
 *   Plugin:   per-guild plugin_guild_features.enabled → operator
 *             override on plugin_feature_defaults → manifest default.
 *
 * Configuration for each individual built-in feature lives on its own
 * sub-tab; this panel only flips the master switch.
 */

const props = defineProps<{ guildId: string }>();
const { t: $t } = useI18n();
const { handle: handleApiError } = useApiError();

const pluginFeatures = ref<GuildFeatureItem[]>([]);
const builtinStates = ref<BuiltinFeatureState[]>([]);
const loading = ref(true);
const error = ref<string | null>(null);
const busy = ref<Set<string>>(new Set());

function pluginKey(item: GuildFeatureItem): string {
    return `plugin:${item.pluginId}|${item.featureKey}`;
}
function builtinRowKey(featureKey: string): string {
    return `builtin:${featureKey}`;
}

const builtinByKey = computed(() => {
    const m = new Map<string, BuiltinFeatureState>();
    for (const b of builtinStates.value) m.set(b.featureKey, b);
    return m;
});

interface BuiltinRow {
    key: string;
    label: string;
    icon: string;
    /** effective enabled for this guild: per-guild override → default → true */
    enabled: boolean;
    /** explicit per-guild row exists */
    overridden: boolean;
    /** the operator default (post-override resolution) for context */
    defaultEnabled: boolean;
}

const builtinRows = computed<BuiltinRow[]>(() =>
    builtinRegistry.map(reg => {
        const slot = builtinByKey.value.get(reg.name);
        const perGuild = slot?.perGuild.find(g => g.guildId === props.guildId);
        const def = slot?.effectiveDefault ?? true;
        return {
            key: reg.name,
            label: $t(reg.labelKey),
            icon: reg.icon,
            enabled: perGuild ? perGuild.enabled : def,
            overridden: !!perGuild,
            defaultEnabled: def
        };
    })
);

async function refresh() {
    if (!props.guildId) return;
    loading.value = true;
    error.value = null;
    try {
        const [pf, bs] = await Promise.all([
            listGuildFeatures(props.guildId),
            listBuiltinFeatureState()
        ]);
        pluginFeatures.value = pf;
        builtinStates.value = bs;
    } catch (err) {
        if (handleApiError(err) !== 'unhandled') return;
        error.value = err instanceof Error ? err.message : 'load failed';
    } finally {
        loading.value = false;
    }
}

async function onTogglePlugin(item: GuildFeatureItem) {
    const k = pluginKey(item);
    if (busy.value.has(k)) return;
    busy.value.add(k);
    const next = !item.enabled;
    try {
        await setGuildFeatureEnabled(item.pluginId, props.guildId, item.featureKey, next);
        item.enabled = next;
        item.overridden = true; // toggling creates an explicit per-guild row
    } catch (err) {
        if (handleApiError(err) !== 'unhandled') return;
        error.value = err instanceof Error ? err.message : 'toggle failed';
    } finally {
        busy.value.delete(k);
    }
}

// ── PD-1.3: 生效層標示 + 清除覆寫 + per-guild config 編輯 ──────────

/** 目前生效層的人話標示（per-guild 覆寫 → operator 預設 → manifest 預設）。 */
function tierLabel(item: GuildFeatureItem): string {
    if (item.overridden) return '此伺服器已覆寫';
    return item.operatorDefault !== null ? '跟隨 operator 預設' : '跟隨 manifest 預設';
}
function defaultTierName(item: GuildFeatureItem): string {
    return item.operatorDefault !== null ? 'operator 預設' : 'manifest 預設';
}

// 清除覆寫（連同 per-guild config 一起刪——config 就存在覆寫 row 上）
const clearTarget = ref<GuildFeatureItem | null>(null);
const clearing = ref(false);
async function confirmClearOverride() {
    const item = clearTarget.value;
    if (!item || clearing.value) return;
    clearing.value = true;
    try {
        await clearGuildFeatureOverride(item.pluginId, props.guildId, item.featureKey);
        clearTarget.value = null;
        await refresh();
    } catch (err) {
        if (handleApiError(err) !== 'unhandled') return;
        error.value = err instanceof Error ? err.message : 'clear failed';
    } finally {
        clearing.value = false;
    }
}

// 行內 config 編輯器：一次展開一列，欄位渲染比照 plugin 詳情頁的
// config editor（字串值表單；boolean 存 'true'/'false'；secret 用
// '********' sentinel 表示「已存值、留著不變」）。
const configOpenKey = ref<string | null>(null);
const configValues = reactive<Record<string, string>>({});
const configFieldErrors = ref<Array<{ key: string; message: string }>>([]);
const configSaving = ref(false);
const configError = ref<string | null>(null);
const configSavedAt = ref<number | null>(null);

function toggleConfig(item: GuildFeatureItem) {
    const k = pluginKey(item);
    if (configOpenKey.value === k) {
        configOpenKey.value = null;
        return;
    }
    configOpenKey.value = k;
    configFieldErrors.value = [];
    configError.value = null;
    for (const key of Object.keys(configValues)) delete configValues[key];
    for (const field of item.configSchema) {
        const raw = item.config[field.key];
        if (field.type === 'secret') {
            // 後端不回 secret 明文（存的是加密 blob）——非空即視為已設。
            configValues[field.key] = typeof raw === 'string' && raw.length > 0 ? '********' : '';
        } else if (field.type === 'boolean') {
            configValues[field.key] = raw === true || raw === 'true' ? 'true' : 'false';
        } else if (raw === null || raw === undefined) {
            configValues[field.key] = (field.default as string | undefined) ?? '';
        } else {
            configValues[field.key] = String(raw);
        }
    }
}

function fieldErrorFor(key: string): string | null {
    return configFieldErrors.value.find((e) => e.key === key)?.message ?? null;
}

async function saveFeatureConfig(item: GuildFeatureItem) {
    if (configSaving.value) return;
    configSaving.value = true;
    configError.value = null;
    configFieldErrors.value = [];
    try {
        await setGuildFeatureConfig(item.pluginId, props.guildId, item.featureKey, { ...configValues });
        configSavedAt.value = Date.now();
        await refresh();
    } catch (err) {
        if (err instanceof ConfigValidationError) {
            configFieldErrors.value = err.fieldErrors;
            return;
        }
        if (handleApiError(err) !== 'unhandled') return;
        configError.value = err instanceof Error ? err.message : 'save failed';
    } finally {
        configSaving.value = false;
    }
}

async function onToggleBuiltin(row: BuiltinRow) {
    const k = builtinRowKey(row.key);
    if (busy.value.has(k)) return;
    busy.value.add(k);
    const next = !row.enabled;
    try {
        await setBuiltinFeatureState(row.key, next, props.guildId);
        await refresh();
    } catch (err) {
        if (handleApiError(err) !== 'unhandled') return;
        error.value = err instanceof Error ? err.message : 'toggle failed';
    } finally {
        busy.value.delete(k);
    }
}

onMounted(refresh);
watch(() => props.guildId, refresh);
</script>

<template>
    <article class="bot-features-panel">
        <header class="panel-header">
            <div>
                <h3>功能管理(此伺服器)</h3>
                <p class="muted">
                    在此切換每個內建或 Plugin 功能在此伺服器的開關。內建功能的詳細設定可在對應的子分頁進行調整;
                    若想統一改變所有伺服器的預設值,請到「所有伺服器 → Bot 功能」頁面。
                </p>
            </div>
            <button type="button" class="btn ghost small" :disabled="loading" @click="refresh">
                <Icon icon="material-symbols:refresh-rounded" />
                重新整理
            </button>
        </header>

        <p v-if="error" class="error">{{ error }}</p>
        <p v-if="loading" class="muted">載入中…</p>

        <template v-else>
            <section class="feature-section">
                <h4 class="section-title">
                    <Icon icon="material-symbols:settings-outline-rounded" />
                    內建功能
                </h4>
                <ul class="feature-list">
                    <li v-for="row in builtinRows" :key="row.key" class="feature-row">
                        <Icon :icon="row.icon" class="feature-icon" />
                        <div class="feature-meta">
                            <div class="feature-name">{{ row.label }}</div>
                            <div class="feature-stats muted">
                                <template v-if="row.overridden">
                                    <span>此伺服器已覆寫:{{ row.enabled ? '啟用' : '停用' }}</span>
                                    <span class="dot">·</span>
                                    <span>預設:{{ row.defaultEnabled ? '啟用' : '停用' }}</span>
                                </template>
                                <template v-else>
                                    <span>使用預設:{{ row.defaultEnabled ? '啟用' : '停用' }}</span>
                                </template>
                            </div>
                        </div>
                        <AppToggle
                            :model-value="row.enabled"
                            :disabled="busy.has(builtinRowKey(row.key))"
                            :title="row.enabled ? '停用此功能' : '啟用此功能'"
                            :aria-label="row.enabled ? '停用此功能' : '啟用此功能'"
                            @update:model-value="onToggleBuiltin(row)"
                        />
                    </li>
                </ul>
            </section>

            <section class="feature-section">
                <h4 class="section-title">
                    <Icon icon="material-symbols:extension-outline-rounded" />
                    Plugin Features
                </h4>
                <p v-if="pluginFeatures.length === 0" class="muted empty">
                    目前沒有 plugin 提供 guild feature。
                </p>
                <ul v-else class="feature-list">
                    <li v-for="item in pluginFeatures" :key="pluginKey(item)" class="feature-row">
                        <Icon v-if="item.icon" :icon="item.icon" class="feature-icon" />
                        <Icon v-else icon="material-symbols:extension-outline" class="feature-icon" />
                        <div class="feature-meta">
                            <div class="feature-name">
                                {{ item.name }}
                                <span class="plugin-tag muted">({{ item.pluginName }})</span>
                            </div>
                            <div v-if="item.description" class="feature-desc muted">{{ item.description }}</div>
                            <!-- 生效層標示（PD-1.3）:一眼可辨目前值由哪一層決定 -->
                            <div class="feature-stats muted">
                                <span class="tier-chip" :class="{ overridden: item.overridden }">{{ tierLabel(item) }}</span>
                                <template v-if="item.overridden">
                                    <span class="dot">·</span>
                                    <span>預設:{{ item.defaultEnabled ? '啟用' : '停用' }}（{{ defaultTierName(item) }}）</span>
                                    <button
                                        type="button"
                                        class="link-btn"
                                        :disabled="clearing"
                                        @click="clearTarget = item"
                                    >清除覆寫</button>
                                </template>
                                <template v-else>
                                    <span class="dot">·</span>
                                    <span>{{ item.defaultEnabled ? '啟用' : '停用' }}</span>
                                </template>
                                <template v-if="item.configSchema.length > 0">
                                    <span class="dot">·</span>
                                    <button type="button" class="link-btn" @click="toggleConfig(item)">
                                        {{ configOpenKey === pluginKey(item) ? '收起設定' : '功能設定' }}
                                    </button>
                                </template>
                            </div>
                            <div v-if="!item.pluginEnabled || item.pluginStatus !== 'active'" class="warn">
                                ⚠ Plugin 目前 {{ !item.pluginEnabled ? '已停用' : '不在線' }};即使 toggle 開啟也不會收到事件。
                            </div>

                            <!-- 行內 per-guild config 編輯器（PD-1.3） -->
                            <div v-if="configOpenKey === pluginKey(item)" class="config-editor">
                                <p v-if="configError" class="error" role="alert">{{ configError }}</p>
                                <label
                                    v-for="field in item.configSchema"
                                    :key="field.key"
                                    :class="['config-field', { 'has-error': fieldErrorFor(field.key) !== null }]"
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
                                    <span v-if="configSavedAt && (Date.now() - configSavedAt < 4000)" class="saved-hint">已儲存</span>
                                    <button type="button" class="btn small" :disabled="configSaving" @click="saveFeatureConfig(item)">
                                        {{ configSaving ? '儲存中…' : '儲存設定' }}
                                    </button>
                                </div>
                                <p class="muted config-note">儲存設定會在此伺服器建立明確覆寫（設定值存於覆寫上）;「清除覆寫」會連同設定一起移除。</p>
                            </div>
                        </div>
                        <AppToggle
                            :model-value="item.enabled"
                            :disabled="busy.has(pluginKey(item)) || !item.pluginEnabled"
                            :title="item.enabled ? '停用此功能' : '啟用此功能'"
                            :aria-label="item.enabled ? '停用此功能' : '啟用此功能'"
                            @update:model-value="onTogglePlugin(item)"
                        />
                    </li>
                </ul>
            </section>
        </template>

        <AppConfirmDialog
            :visible="clearTarget !== null"
            title="清除此伺服器的覆寫"
            :message="`將移除「${clearTarget?.name ?? ''}」在此伺服器的明確覆寫與其功能設定（config），之後跟隨${clearTarget ? defaultTierName(clearTarget) : '預設'}（${clearTarget?.defaultEnabled ? '啟用' : '停用'}）。要繼續嗎？`"
            confirm-label="清除覆寫"
            confirm-variant="danger"
            :loading="clearing"
            loading-label="清除中…"
            @confirm="confirmClearOverride"
            @close="clearTarget = null"
        />
    </article>
</template>

<style scoped>
.bot-features-panel { display: flex; flex-direction: column; gap: 0.75rem; }
.panel-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 1rem;
    /* See AllServersDashboard.vue page-header — flex-wrap keeps the
       refresh button from being visually squashed when the sibling
       description text is long; flex-shrink:0 on .btn keeps the button
       at content size. */
    flex-wrap: wrap;
}
.panel-header > div { flex: 1 1 320px; min-width: 0; }
.panel-header h3 { margin: 0 0 0.25rem 0; font-size: 1rem; }
.muted { color: var(--text-muted); font-size: 0.85rem; margin: 0; }
.empty { padding: 1rem; text-align: center; }
.error {
    color: var(--danger);
    background: rgba(239, 68, 68, 0.1);
    border: 1px solid rgba(239, 68, 68, 0.35);
    border-radius: var(--radius-sm);
    padding: 0.55rem 0.75rem;
}
.warn { color: var(--warning, #f59e0b); font-size: 0.78rem; margin-top: 0.2rem; }

.feature-section {
    border: 1px solid var(--border);
    border-radius: var(--radius);
    overflow: hidden;
    background: var(--bg-surface);
}
.section-title {
    display: flex; align-items: center; gap: 0.45rem;
    font-size: 0.92rem;
    margin: 0;
    padding: 0.55rem 0.75rem;
    color: var(--text-strong);
    background: var(--bg-surface-2);
    border-bottom: 1px solid var(--border);
}
.feature-list { list-style: none; margin: 0; padding: 0; }
.feature-row {
    display: flex; gap: 0.85rem;
    padding: 0.7rem 0.75rem;
    align-items: flex-start;
    border-bottom: 1px solid var(--border);
}
.feature-row:last-child { border-bottom: none; }
.feature-icon {
    width: 20px; height: 20px; flex-shrink: 0; margin-top: 0.15rem;
    color: var(--text-muted);
}
.feature-meta { flex: 1; min-width: 0; }
.feature-name { font-weight: 500; color: var(--text-strong); }
.feature-desc { font-size: 0.82rem; line-height: 1.35; margin-top: 0.2rem; }
.feature-stats {
    display: flex; flex-wrap: wrap; gap: 0.35rem;
    font-size: 0.75rem; margin-top: 0.2rem;
}
.feature-stats .dot { opacity: 0.4; }
.plugin-tag { font-weight: 400; font-size: 0.78rem; }
.feature-row :deep(.app-toggle) { margin-top: 0.15rem; }
.btn {
    display: inline-flex; align-items: center; gap: 0.35rem;
    padding: 0.4rem 0.7rem;
    border: 1px solid var(--border-strong);
    background: var(--bg-surface);
    color: var(--text);
    border-radius: var(--radius-sm);
    cursor: pointer;
    font-size: 0.82rem;
    flex-shrink: 0;
    white-space: nowrap;
}
.btn:hover:not(:disabled) { background: var(--bg-surface-hover); }
.btn:disabled { cursor: not-allowed; opacity: 0.55; }
.btn.ghost { background: transparent; }
.btn.small { padding: 0.3rem 0.55rem; font-size: 0.78rem; }

/* ── PD-1.3: 生效層 chip / 清除覆寫 / 行內 config 編輯器 ─────────── */
.tier-chip {
    display: inline-block;
    padding: 0.05rem 0.4rem;
    border: 1px solid var(--border-strong);
    border-radius: 999px;
    font-size: 0.72rem;
    color: var(--text-muted);
}
.tier-chip.overridden {
    color: var(--accent, #5865f2);
    border-color: color-mix(in srgb, var(--accent, #5865f2) 45%, transparent);
}
.link-btn {
    background: none;
    border: none;
    padding: 0;
    font-size: 0.75rem;
    color: var(--accent, #5865f2);
    cursor: pointer;
    text-decoration: underline;
    text-underline-offset: 2px;
}
.link-btn:disabled { opacity: 0.55; cursor: not-allowed; }

.config-editor {
    margin-top: 0.5rem;
    padding: 0.6rem 0.7rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg-surface-2);
    display: flex;
    flex-direction: column;
    gap: 0.55rem;
}
.config-field {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
}
.config-field.has-error input,
.config-field.has-error textarea,
.config-field.has-error select {
    border-color: var(--danger, #dc2626);
}
.config-label {
    font-size: 0.75rem;
    font-weight: 600;
    color: var(--text-strong);
    display: flex;
    align-items: baseline;
    gap: 0.35rem;
    flex-wrap: wrap;
}
.config-label .req { color: var(--danger, #dc2626); }
.config-label .hint { font-weight: 400; color: var(--text-muted); }
.config-field input[type="text"],
.config-field input[type="password"],
.config-field input[type="number"],
.config-field textarea,
.config-field select {
    padding: 0.35rem 0.5rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg-surface);
    color: var(--text);
    font: inherit;
    font-size: 0.82rem;
    width: 100%;
    box-sizing: border-box;
}
.field-error {
    font-size: 0.75rem;
    color: var(--danger, #dc2626);
}
.config-actions {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 0.5rem;
}
.saved-hint { font-size: 0.75rem; color: var(--success, #16a34a); }
.config-note { font-size: 0.72rem; }
</style>

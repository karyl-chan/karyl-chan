<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Icon } from '@iconify/vue';
import { RouterLink } from 'vue-router';
import { AppBadge, AppButton, AppConfirmDialog, AppItemCard, AppMenu, AppMenuItem, AppToggle } from '@karyl-chan/ui';
import {
    deletePlugin,
    getPluginConfig,
    probePluginDispatch,
    setPluginConfig,
    setPluginEnabled,
    type PluginConfigField,
    type PluginDispatchProbeResult,
    type PluginRecord
} from '../../../api/plugins';
import { dispatchProblem, sdkCompatProblem } from './plugin-card-health';

const props = defineProps<{
    plugin: PluginRecord;
}>();

const emit = defineEmits<{
    (e: 'updated', plugin: { id: number; pluginKey: string; enabled: boolean }): void;
    (e: 'deleted', id: number): void;
}>();

const { t } = useI18n();

const open = ref(false);
const saving = ref(false);
const error = ref<string | null>(null);

// Same single-source pattern that finally fixed the behaviors toggle:
// drive the visual state from a local ref that we update optimistically
// on click and reconcile from the prop on success/failure.
const enabledLocal = ref(props.plugin.enabled);
// Watch the prop in case the parent reloads the list and hands us a
// fresh PluginRecord with a different `enabled`.
watch(() => props.plugin.enabled, (next) => { enabledLocal.value = next; });

// Plugin-level config (admin-editable). Loaded lazily on the first
// expand so collapsed cards don't fan out N+1 GETs at page load.
// Each field's "set" status drives the secret placeholder UX —
// secrets come back as "********" sentinel; keeping the sentinel in
// the form means the PUT will skip re-encrypting when the user didn't
// change it (see backend route comment).
const configSchema = ref<PluginConfigField[]>([]);
const configValues = reactive<Record<string, string>>({});
const configLoaded = ref(false);
const configLoading = ref(false);
const configSaving = ref(false);
const configError = ref<string | null>(null);
const configSavedAt = ref<number | null>(null);

const hasConfigSchema = computed(() =>
    (props.plugin.manifest?.config_schema?.length ?? 0) > 0
);

async function loadConfig() {
    if (configLoaded.value || configLoading.value) return;
    configLoading.value = true;
    configError.value = null;
    try {
        const r = await getPluginConfig(props.plugin.id);
        configSchema.value = r.schema;
        for (const v of r.values) {
            // Use empty string for "unset" so two-way binding has a real
            // string. The save path treats "" + non-secret type as
            // "store empty value" which round-trips fine.
            configValues[v.key] = v.value ?? '';
        }
        // Seed defaults for keys the server didn't return (e.g. brand-
        // new schema field) so the form renders something to type into.
        for (const f of r.schema) {
            if (!(f.key in configValues)) {
                configValues[f.key] = (f.default as string | undefined) ?? '';
            }
        }
        configLoaded.value = true;
    } catch (err) {
        configError.value = err instanceof Error ? err.message : String(err);
    } finally {
        configLoading.value = false;
    }
}

async function saveConfig() {
    if (configSaving.value) return;
    configSaving.value = true;
    configError.value = null;
    try {
        // Send everything in the form back. The backend skips secret
        // fields whose value is still the "********" sentinel, so
        // unchanged secrets stay encrypted at rest.
        await setPluginConfig(props.plugin.id, { ...configValues });
        configSavedAt.value = Date.now();
    } catch (err) {
        configError.value = err instanceof Error ? err.message : String(err);
    } finally {
        configSaving.value = false;
    }
}

// Lazily fetch config the first time the card opens AND there is a
// schema to render. Subsequent opens reuse the in-memory state.
watch(open, (isOpen) => {
    if (isOpen && hasConfigSchema.value) void loadConfig();
});

const statusColor = computed(() =>
    props.plugin.status === 'active' ? 'var(--success, #16a34a)' : 'var(--text-muted)'
);
const statusLabel = computed(() =>
    props.plugin.status === 'active'
        ? t('admin.plugins.statusActive')
        : t('admin.plugins.statusInactive')
);

const lastHeartbeat = computed(() => {
    if (!props.plugin.lastHeartbeatAt) return t('admin.plugins.neverHeartbeat');
    const d = new Date(props.plugin.lastHeartbeatAt);
    const ageSec = Math.floor((Date.now() - d.getTime()) / 1000);
    if (ageSec < 60) return t('admin.plugins.heartbeatJustNow');
    if (ageSec < 3600) return t('admin.plugins.heartbeatMinutesAgo', { n: Math.floor(ageSec / 60) });
    if (ageSec < 86400) return t('admin.plugins.heartbeatHoursAgo', { n: Math.floor(ageSec / 3600) });
    return d.toLocaleString();
});

// Background command-sync state (PM-7.6): surface a failed sync, or a
// pending one that has been running suspiciously long (rate-limited
// Discord call). A fresh/ok sync renders nothing — quiet by default.
const SYNC_STALL_MS = 60_000;
const commandSyncProblem = computed<null | { kind: 'failed' | 'stalled' | 'rateLimited'; detail: string }>(() => {
    const s = props.plugin.commandSync;
    if (!s) return null;
    if (s.status === 'failed') return { kind: 'failed', detail: s.error ?? '' };
    if (s.status === 'rate_limited') return { kind: 'rateLimited', detail: s.error ?? '' };
    if (s.status === 'pending' && Date.now() - s.startedAt > SYNC_STALL_MS) {
        return { kind: 'stalled', detail: '' };
    }
    return null;
});

// Dispatch-path health (PM-7.9.2): liveness (status dot / heartbeat)
// and dispatch are separate signals — a plugin can heartbeat green
// while rejecting every dispatch (HMAC scheme mismatch). Quiet unless
// a failure streak crosses the threshold.
const dispatchAlarm = computed(() => dispatchProblem(props.plugin.dispatch));
const sdkAlarm = computed(() => sdkCompatProblem(props.plugin.sdkCompat, props.plugin.version));
const dispatchStateText = computed(() => {
    const d = props.plugin.dispatch;
    if (!d) return t('admin.plugins.dispatchNone');
    if (dispatchAlarm.value) {
        return t('admin.plugins.dispatchFailingShort', { n: dispatchAlarm.value.streak });
    }
    return t('admin.plugins.dispatchOk', { ok: d.okCount, total: d.total });
});

// Manual dispatch probe (PM-7.9.4): same signed no-op check the bot
// fires after register; lets the operator verify the HMAC path on
// demand. The verdict renders inline; the badge state refreshes on
// the next list reload.
const probing = ref(false);
const probeResult = ref<PluginDispatchProbeResult | null>(null);
async function onProbe() {
    if (probing.value) return;
    probing.value = true;
    probeResult.value = null;
    try {
        const r = await probePluginDispatch(props.plugin.id);
        probeResult.value = r.probe;
    } catch (err) {
        probeResult.value = {
            outcome: 'inconclusive',
            message: err instanceof Error ? err.message : String(err),
        };
    } finally {
        probing.value = false;
    }
}
const probeText = computed(() => {
    const p = probeResult.value;
    if (!p) return '';
    switch (p.outcome) {
        case 'signature_ok': return t('admin.plugins.probeOk', { status: p.status });
        case 'rejected_401': return t('admin.plugins.probeRejected');
        case 'awaiting_register': return t('admin.plugins.probeAwaiting');
        case 'skipped': return t('admin.plugins.probeSkipped', { reason: p.reason });
        default: return t('admin.plugins.probeInconclusive', { m: p.message ?? '' });
    }
});
const probeOkState = computed(() => probeResult.value?.outcome === 'signature_ok');

const guildFeatureCount = computed(() => props.plugin.manifest?.guild_features?.length ?? 0);
// Top-level (truly global) commands and per-feature commands count
// separately — they have different runtime gating semantics, so the
// admin UI surfaces both.
const globalCommandCount = computed(() => props.plugin.manifest?.commands?.length ?? 0);
const featureCommandCount = computed(() =>
    (props.plugin.manifest?.guild_features ?? []).reduce(
        (n, f) => n + (f.commands?.length ?? 0), 0
    )
);
const commandCount = computed(() => globalCommandCount.value + featureCommandCount.value);
const rpcScopes = computed(() => props.plugin.manifest?.rpc_methods_used ?? []);
const description = computed(() => props.plugin.manifest?.plugin.description ?? '');

async function onToggleEnabled() {
    if (saving.value) return;
    const next = !enabledLocal.value;
    enabledLocal.value = next;
    saving.value = true;
    error.value = null;
    try {
        const updated = await setPluginEnabled(props.plugin.id, next);
        emit('updated', updated);
    } catch (err) {
        error.value = err instanceof Error ? err.message : String(err);
        enabledLocal.value = props.plugin.enabled;
    } finally {
        saving.value = false;
    }
}

// ── Delete (inactive plugins only) ──────────────────────────────────
const deleteModalOpen = ref(false);
const deleting = ref(false);
const deleteError = ref<string | null>(null);

function openDeleteModal() {
    deleteModalOpen.value = true;
    deleteError.value = null;
}

async function confirmDelete() {
    if (deleting.value) return;
    deleting.value = true;
    deleteError.value = null;
    try {
        await deletePlugin(props.plugin.id);
        deleteModalOpen.value = false;
        emit('deleted', props.plugin.id);
    } catch (err) {
        deleteError.value = err instanceof Error ? err.message : String(err);
    } finally {
        deleting.value = false;
    }
}
</script>

<template>
    <AppItemCard v-model:expanded="open" :disabled="!enabledLocal">
        <template #title>
            <span class="title">{{ plugin.name }}</span>
            <span class="key">{{ plugin.pluginKey }}</span>
            <span class="version">v{{ plugin.version }}</span>
        </template>
        <template #trailing>
            <span class="status-dot" :style="{ background: statusColor }" :title="statusLabel" />
            <span class="status-text">{{ statusLabel }}</span>
            <RouterLink
                :to="{ name: 'plugin-detail', params: { pluginKey: plugin.pluginKey } }"
                class="detail-link"
                :title="t('admin.plugins.viewDetail')"
                @click.stop
            >
                <Icon icon="material-symbols:open-in-new-rounded" width="15" height="15" />
            </RouterLink>
            <AppToggle
                :model-value="enabledLocal"
                :title="enabledLocal ? t('admin.plugins.toggleEnabled') : t('admin.plugins.toggleDisabled')"
                :aria-label="enabledLocal ? t('admin.plugins.toggleEnabled') : t('admin.plugins.toggleDisabled')"
                :disabled="saving"
                @update:model-value="onToggleEnabled"
            />
            <!-- Three-dot menu: only for inactive plugins -->
            <AppMenu v-if="plugin.status === 'inactive'" placement="bottom-end" :offset="[0, 6]">
                <template #trigger>
                    <button
                        type="button"
                        class="more-btn"
                        :title="t('admin.plugins.menu.delete')"
                    >
                        <Icon icon="material-symbols:more-vert" width="16" height="16" />
                    </button>
                </template>
                <AppMenuItem danger icon="material-symbols:delete-outline-rounded" @click="openDeleteModal">
                    {{ t('admin.plugins.menu.delete') }}
                </AppMenuItem>
            </AppMenu>
        </template>

        <template #default>
            <p v-if="description" class="desc">{{ description }}</p>

            <div class="stats-row">
                <AppBadge v-if="guildFeatureCount > 0" variant="outline" icon="material-symbols:hub-outline">
                    {{ t('admin.plugins.guildFeaturesCount', { n: guildFeatureCount }) }}
                </AppBadge>
                <AppBadge v-if="commandCount > 0" variant="outline" icon="material-symbols:terminal">
                    {{ t('admin.plugins.commandsCount', { n: commandCount }) }}
                </AppBadge>
                <AppBadge
                    v-if="commandSyncProblem"
                    variant="outline"
                    icon="material-symbols:sync-problem"
                    class="sync-problem-badge"
                    :title="commandSyncProblem.detail"
                >
                    {{
                        commandSyncProblem.kind === 'failed'
                            ? t('admin.plugins.commandSyncFailed')
                            : commandSyncProblem.kind === 'rateLimited'
                                ? t('admin.plugins.commandSyncRateLimited')
                                : t('admin.plugins.commandSyncStalled')
                    }}
                </AppBadge>
                <AppBadge
                    v-if="dispatchAlarm"
                    variant="outline"
                    icon="material-symbols:dangerous-outline"
                    class="dispatch-problem-badge"
                    :title="dispatchAlarm.detail"
                >
                    {{
                        dispatchAlarm.kind === 'rejected401'
                            ? t('admin.plugins.dispatchRejected401', { n: dispatchAlarm.streak })
                            : t('admin.plugins.dispatchFailing', { n: dispatchAlarm.streak })
                    }}
                </AppBadge>
                <AppBadge
                    v-if="sdkAlarm"
                    variant="outline"
                    icon="material-symbols:warning-outline"
                    class="dispatch-problem-badge"
                    :title="t('admin.plugins.sdkTooOldHint')"
                >
                    {{
                        sdkAlarm.kind === 'tooOld'
                            ? t('admin.plugins.sdkTooOld', { v: sdkAlarm.sdkVersion ?? '?', min: sdkAlarm.minCompatible })
                            : t('admin.plugins.sdkUnknownOld', { min: sdkAlarm.minCompatible })
                    }}
                </AppBadge>
            </div>

            <dl class="meta">
                <div class="meta-row">
                    <dt>{{ t('admin.plugins.url') }}</dt>
                    <dd><code>{{ plugin.url }}</code></dd>
                </div>
                <div class="meta-row">
                    <dt>{{ t('admin.plugins.lastHeartbeat') }}</dt>
                    <dd>{{ lastHeartbeat }}</dd>
                </div>
                <div class="meta-row">
                    <dt>{{ t('admin.plugins.dispatchLabel') }}</dt>
                    <dd :class="{ 'dispatch-bad': dispatchAlarm }">
                        {{ dispatchStateText }}
                        <button
                            type="button"
                            class="probe-btn"
                            :disabled="probing"
                            :title="t('admin.plugins.probeHint')"
                            @click="onProbe"
                        >
                            {{ probing ? t('admin.plugins.probing') : t('admin.plugins.probeButton') }}
                        </button>
                        <span
                            v-if="probeResult"
                            :class="probeOkState ? 'probe-ok' : 'dispatch-bad'"
                        >{{ probeText }}</span>
                    </dd>
                </div>
                <div class="meta-row" v-if="plugin.sdkCompat?.sdkVersion || sdkAlarm">
                    <dt>{{ t('admin.plugins.sdkVersionLabel') }}</dt>
                    <dd :class="{ 'dispatch-bad': sdkAlarm }">
                        <code>{{ plugin.sdkCompat?.sdkVersion ?? t('admin.plugins.sdkNoStamp') }}</code>
                    </dd>
                </div>
                <div class="meta-row" v-if="rpcScopes.length > 0">
                    <dt>{{ t('admin.plugins.rpcScopes') }}</dt>
                    <dd>
                        <code v-for="s in rpcScopes" :key="s" class="scope-chip">{{ s }}</code>
                    </dd>
                </div>
            </dl>

            <!-- Plugin-level config editor. Only renders when the
                 plugin's manifest declares a `config_schema`; values
                 are loaded lazily on first expand. -->
            <section v-if="hasConfigSchema" class="config-section">
                <header class="config-header">
                    <h4>外掛設定</h4>
                    <span v-if="configSavedAt && (Date.now() - configSavedAt < 4000)" class="muted saved">已儲存</span>
                </header>
                <p v-if="configLoading" class="muted">載入中…</p>
                <p v-if="configError" class="error" role="alert">{{ configError }}</p>
                <div v-else-if="configLoaded" class="config-grid">
                    <label
                        v-for="field in configSchema"
                        :key="field.key"
                        :class="['config-field', { full: field.type === 'textarea' }]"
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
                        <AppToggle
                            v-else-if="field.type === 'boolean'"
                            :modelValue="configValues[field.key] === 'true'"
                            :aria-label="field.label || field.key"
                            @update:modelValue="(v) => { configValues[field.key] = v ? 'true' : 'false'; }"
                        />
                        <input
                            v-else
                            v-model="configValues[field.key]"
                            :type="field.type === 'secret' ? 'password' : (field.type === 'number' ? 'number' : 'text')"
                            :placeholder="field.type === 'secret' ? '留空 = 不變更' : ''"
                            autocomplete="off"
                            spellcheck="false"
                        />
                    </label>
                    <div class="config-actions">
                        <AppButton variant="primary" size="sm" :loading="configSaving" @click="saveConfig">
                            儲存設定
                        </AppButton>
                    </div>
                </div>
            </section>

            <details v-if="plugin.manifest" class="manifest-fold">
                <summary>{{ t('admin.plugins.manifestRaw') }}</summary>
                <pre>{{ JSON.stringify(plugin.manifest, null, 2) }}</pre>
            </details>

            <p v-if="error" class="error" role="alert">{{ error }}</p>
        </template>
    </AppItemCard>

    <!-- Delete plugin confirmation modal -->
    <AppConfirmDialog
        :visible="deleteModalOpen"
        :title="t('admin.plugins.deleteConfirmTitle')"
        :message="t('admin.plugins.deleteConfirm', { name: plugin.name })"
        :confirm-label="t('admin.plugins.menu.delete')"
        confirm-variant="danger"
        :loading="deleting"
        :error="deleteError ?? undefined"
        @close="deleteModalOpen = false"
        @confirm="confirmDelete"
    />
</template>

<style scoped>
.title {
    font-weight: 600;
    color: var(--text-strong);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.key {
    font-family: var(--font-mono, monospace);
    font-size: 0.78rem;
    color: var(--text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
}
.version {
    font-size: 0.72rem;
    color: var(--text-faint);
    flex-shrink: 0;
}
.status-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
}
.status-text {
    font-size: 0.78rem;
    color: var(--text-muted);
    flex-shrink: 0;
}
.desc {
    margin: 0;
    color: var(--text);
    white-space: pre-wrap;
    line-height: 1.5;
}
.stats-row {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
}
.meta {
    margin: 0;
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 0.3rem 0.6rem;
    font-size: 0.85rem;
}
.meta-row { display: contents; }
.meta dt { color: var(--text-muted); }
.meta dd { margin: 0; color: var(--text); display: flex; flex-wrap: wrap; gap: 0.25rem; }
.meta code {
    font-family: var(--font-mono, monospace);
    font-size: 0.78rem;
    background: var(--bg-page);
    padding: 0.1rem 0.35rem;
    border-radius: var(--radius-sm);
}
.scope-chip { background: var(--bg-page); }
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
.error { color: var(--danger); margin: 0; font-size: 0.85rem; }

.config-section {
    margin-top: 0.6rem;
    padding: 0.6rem 0.75rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg-page);
}
.config-header {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    margin-bottom: 0.5rem;
}
.config-header h4 { margin: 0; font-size: 0.92rem; color: var(--text-strong); flex: 1; }
.muted.saved { color: var(--accent); font-size: 0.78rem; }
.config-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
    gap: 0.6rem 0.85rem;
}
.config-field {
    display: flex; flex-direction: column; gap: 0.25rem;
}
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
.config-actions {
    grid-column: 1 / -1;
    display: flex; justify-content: flex-end;
}

/* ── Scope chips ─────────────────────────────────────────────────── */
.scope-chip--approved {
    background: color-mix(in srgb, var(--success, #16a34a) 14%, var(--bg-page));
    color: var(--success, #16a34a);
    border: 1px solid color-mix(in srgb, var(--success, #16a34a) 30%, transparent);
}
.scope-chip--pending {
    background: color-mix(in srgb, var(--warning, #d97706) 14%, var(--bg-page));
    color: var(--warning, #d97706);
    border: 1px solid color-mix(in srgb, var(--warning, #d97706) 30%, transparent);
}

/* ── Pending badge in card header ───────────────────────────────── */
.sync-problem-badge {
    color: var(--warning, #d97706);
    border-color: var(--warning, #d97706);
}

/* Dispatch-path / SDK-compat alarms (PM-7.9.2) — red, not amber:
   these mean user-visible commands are failing right now. */
.dispatch-problem-badge {
    color: var(--danger, #dc2626);
    border-color: var(--danger, #dc2626);
}
.dispatch-bad { color: var(--danger, #dc2626); }
.probe-ok { color: var(--success, #16a34a); }
.probe-btn {
    padding: 0.05rem 0.45rem;
    font-size: 0.72rem;
    background: none;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-muted);
    cursor: pointer;
}
.probe-btn:hover:not(:disabled) {
    background: var(--bg-surface-hover, var(--bg-page));
    color: var(--text);
}
.probe-btn:disabled { opacity: 0.6; cursor: default; }

.pending-badge {
    display: inline-flex;
    align-items: center;
    gap: 0.22rem;
    padding: 0.18rem 0.5rem;
    font-size: 0.72rem;
    font-weight: 500;
    border-radius: 999px;
    background: color-mix(in srgb, var(--warning, #d97706) 14%, var(--bg-surface));
    color: var(--warning, #d97706);
    border: 1px solid color-mix(in srgb, var(--warning, #d97706) 35%, transparent);
    cursor: pointer;
    flex-shrink: 0;
}
.pending-badge:hover {
    background: color-mix(in srgb, var(--warning, #d97706) 22%, var(--bg-surface));
}

/* ── Pending row in meta table ──────────────────────────────────── */
.pending-row {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem;
    align-items: center;
}

/* ── View detail link ────────────────────────────────────────────── */
.detail-link {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    border-radius: var(--radius-sm);
    color: var(--text-muted);
    text-decoration: none;
    flex-shrink: 0;
    transition: color 0.12s, background 0.12s;
}
.detail-link:hover {
    background: var(--bg-surface-hover, var(--bg-page));
    color: var(--accent);
}

/* ── Three-dot more menu trigger (visual only; AppMenu owns the panel) ─ */
.more-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    background: none;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-muted);
    cursor: pointer;
    padding: 0;
    transition: background 0.12s, color 0.12s;
}
.more-btn:hover {
    background: var(--bg-surface-hover, var(--bg-page));
    color: var(--text);
}

/* ── Scope approve modal internals ───────────────────────────────── */
.acd-scope-body {
    padding: 0.9rem 1rem 0.75rem;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
}
.acd-scope-desc {
    margin: 0;
    color: var(--text);
    font-size: 0.9rem;
    line-height: 1.5;
}
.approve-scope-list {
    margin: 0;
    display: flex;
    flex-wrap: wrap;
    gap: 0.3rem;
}
.approve-scope-list code {
    font-family: var(--font-mono, monospace);
    font-size: 0.8rem;
    padding: 0.15rem 0.45rem;
    border-radius: var(--radius-sm);
    background: color-mix(in srgb, var(--warning, #d97706) 14%, var(--bg-page));
    color: var(--warning, #d97706);
    border: 1px solid color-mix(in srgb, var(--warning, #d97706) 30%, transparent);
}
.acd-scope-actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
    padding-top: 0.25rem;
    border-top: 1px solid var(--border);
}
</style>

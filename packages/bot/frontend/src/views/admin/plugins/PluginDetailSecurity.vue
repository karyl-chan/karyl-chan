<script setup lang="ts">
import { ref, computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { Icon } from '@iconify/vue';
import { AppModal } from '@karyl-chan/ui';
import { AppConfirmDialog } from '@karyl-chan/ui';
import {
    generatePluginSetupSecret,
    setPluginApprovedScopes,
    type PluginDetailRecord,
} from '../../../api/plugins';

const props = defineProps<{
    plugin: PluginDetailRecord;
}>();

const { t } = useI18n();

// ─── RPC scope approval (PM-3.2) ──────────────────────────────────────
// requested = what the manifest declares; approved = the subset the
// issued token carries. The admin checks the scopes to grant and saves.
const requestedScopes = computed<string[]>(
    () => props.plugin.rpcMethods ?? props.plugin.manifest?.rpc_methods_used ?? [],
);
const approved = ref<string[]>([...(props.plugin.approvedRpcScopes ?? [])]);
const checkedScopes = ref<string[]>([...(props.plugin.approvedRpcScopes ?? [])]);
const scopesSaving = ref(false);
const scopesSaved = ref(false);
const scopeError = ref<string | null>(null);

const scopesDirty = computed(() => {
    const a = new Set(checkedScopes.value);
    const b = new Set(approved.value);
    if (a.size !== b.size) return true;
    for (const s of a) if (!b.has(s)) return true;
    return false;
});
const pendingCount = computed(
    () => requestedScopes.value.filter((s) => !approved.value.includes(s)).length,
);

function isApproved(scope: string): boolean {
    return approved.value.includes(scope);
}

function approveAllScopes() {
    checkedScopes.value = [...requestedScopes.value];
}

async function saveScopes() {
    if (scopesSaving.value || !scopesDirty.value) return;
    scopesSaving.value = true;
    scopeError.value = null;
    try {
        const state = await setPluginApprovedScopes(props.plugin.id, checkedScopes.value);
        approved.value = [...state.approved];
        checkedScopes.value = [...state.approved];
        scopesSaved.value = true;
        setTimeout(() => { scopesSaved.value = false; }, 2000);
    } catch (err) {
        scopeError.value = err instanceof Error ? err.message : String(err);
    } finally {
        scopesSaving.value = false;
    }
}

const setupSecretConfirmOpen = ref(false);
const setupSecretResultOpen = ref(false);
const setupSecretGenerating = ref(false);
const setupSecretError = ref<string | null>(null);
const setupSecretValue = ref('');
const setupSecretCopied = ref(false);
const setupSecretAcknowledged = ref(false);

async function confirmGenerateSetupSecret() {
    if (setupSecretGenerating.value) return;
    setupSecretGenerating.value = true;
    setupSecretError.value = null;
    try {
        const result = await generatePluginSetupSecret(props.plugin.pluginKey);
        setupSecretValue.value = result.setupSecret;
        setupSecretAcknowledged.value = false;
        setupSecretCopied.value = false;
        setupSecretConfirmOpen.value = false;
        setupSecretResultOpen.value = true;
    } catch (err) {
        setupSecretError.value = err instanceof Error ? err.message : String(err);
    } finally {
        setupSecretGenerating.value = false;
    }
}

async function copySetupSecret() {
    try {
        await navigator.clipboard.writeText(setupSecretValue.value);
        setupSecretCopied.value = true;
        setTimeout(() => { setupSecretCopied.value = false; }, 2000);
    } catch {
        const el = document.getElementById(`setup-secret-detail-${props.plugin.id}`) as HTMLInputElement | null;
        if (el) {
            el.select();
            el.setSelectionRange(0, el.value.length);
        }
    }
}

function closeSecretResult() {
    setupSecretResultOpen.value = false;
    setupSecretValue.value = '';
    setupSecretAcknowledged.value = false;
    setupSecretCopied.value = false;
}
</script>

<template>
    <div class="tab-panel">
        <section class="section">
            <h3 class="section-title">{{ t('pluginSecurity.rpcScopesTitle') }}</h3>
            <p class="section-desc">{{ t('pluginSecurity.rpcScopesDesc') }}</p>

            <p v-if="requestedScopes.length === 0" class="section-desc scope-empty">
                {{ t('pluginSecurity.rpcScopesNone') }}
            </p>

            <template v-else>
                <p class="scope-summary">
                    {{ t('pluginSecurity.rpcScopesSummary', {
                        approved: approved.length,
                        requested: requestedScopes.length,
                        pending: pendingCount,
                    }) }}
                </p>
                <ul class="scope-list">
                    <li v-for="scope in requestedScopes" :key="scope" class="scope-item">
                        <label class="scope-label">
                            <input
                                type="checkbox"
                                class="scope-checkbox"
                                :value="scope"
                                v-model="checkedScopes"
                            />
                            <code class="scope-code">{{ scope }}</code>
                        </label>
                        <span v-if="!isApproved(scope)" class="pending-badge">
                            {{ t('pluginSecurity.rpcScopesPendingBadge') }}
                        </span>
                    </li>
                </ul>
                <div class="scope-actions">
                    <button type="button" class="ghost-btn" @click="approveAllScopes">
                        {{ t('pluginSecurity.rpcScopesApproveAll') }}
                    </button>
                    <button
                        type="button"
                        class="primary-btn"
                        :class="{ saved: scopesSaved }"
                        :disabled="scopesSaving || !scopesDirty"
                        @click="saveScopes"
                    >
                        <Icon
                            v-if="scopesSaved"
                            icon="material-symbols:check-rounded"
                            width="14"
                            height="14"
                        />
                        {{ scopesSaved ? t('pluginSecurity.rpcScopesSaved') : t('pluginSecurity.rpcScopesSave') }}
                    </button>
                </div>
                <p v-if="scopeError" class="scope-error" role="alert">{{ scopeError }}</p>
            </template>
        </section>

        <section class="section">
            <h3 class="section-title">Setup Secret</h3>
            <p class="section-desc">
                {{ t('pluginSecurity.setupSecretDesc') }}
            </p>
            <div class="section-action">
                <button
                    type="button"
                    class="danger-btn"
                    @click="setupSecretConfirmOpen = true"
                >
                    <Icon icon="material-symbols:key-outline-rounded" width="14" height="14" />
                    {{ t('admin.plugins.setupSecret.button') }}
                </button>
            </div>
        </section>
    </div>

    <!-- Setup secret: confirm modal -->
    <AppConfirmDialog
        :visible="setupSecretConfirmOpen"
        :title="t('admin.plugins.setupSecret.confirmTitle')"
        :message="t('admin.plugins.setupSecret.confirmBody', { name: plugin.name })"
        :confirm-label="t('admin.plugins.setupSecret.button')"
        confirm-variant="danger"
        :loading="setupSecretGenerating"
        :error="setupSecretError ?? undefined"
        @close="setupSecretConfirmOpen = false"
        @confirm="confirmGenerateSetupSecret"
    />

    <!-- Setup secret: result modal (cleartext, shown once) -->
    <AppModal
        :visible="setupSecretResultOpen"
        :title="t('admin.plugins.setupSecret.resultTitle')"
        :close-on-backdrop="false"
        :close-on-escape="false"
        width="min(540px, 94vw)"
        @close="closeSecretResult"
    >
        <div class="secret-result-body">
            <p class="secret-result-label">{{ t('admin.plugins.setupSecret.secretLabel') }}</p>
            <div class="secret-input-row">
                <input
                    :id="`setup-secret-detail-${plugin.id}`"
                    type="text"
                    class="secret-input"
                    :value="setupSecretValue"
                    readonly
                    spellcheck="false"
                    autocomplete="off"
                    @click="($event.target as HTMLInputElement).select()"
                />
                <button type="button" class="copy-btn" :class="{ copied: setupSecretCopied }" @click="copySetupSecret">
                    <Icon
                        :icon="setupSecretCopied ? 'material-symbols:check-rounded' : 'material-symbols:content-copy-outline-rounded'"
                        width="15"
                        height="15"
                    />
                    {{ setupSecretCopied ? t('admin.plugins.setupSecret.copiedButton') : t('admin.plugins.setupSecret.copyButton') }}
                </button>
            </div>
            <p class="secret-instruction">{{ t('admin.plugins.setupSecret.instruction') }}</p>
            <div class="secret-env-hint">
                <code>{{ t('admin.plugins.setupSecret.envHint', { secret: setupSecretValue }) }}</code>
            </div>
            <div class="secret-warning" role="alert">
                <Icon icon="material-symbols:warning-outline-rounded" width="15" height="15" class="secret-warning-icon" />
                <span>{{ t('admin.plugins.setupSecret.warning') }}</span>
            </div>
            <label class="secret-ack-label">
                <input type="checkbox" v-model="setupSecretAcknowledged" class="secret-ack-checkbox" />
                <span>{{ t('admin.plugins.setupSecret.checkboxLabel') }}</span>
            </label>
            <div class="secret-result-actions">
                <button type="button" class="primary" :disabled="!setupSecretAcknowledged" @click="closeSecretResult">
                    {{ t('admin.plugins.setupSecret.closeButton') }}
                </button>
            </div>
        </div>
    </AppModal>
</template>

<style scoped>
.tab-panel {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    padding: 0.5rem 0;
}
.section {
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-base);
    padding: 0.8rem 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
}
.section-title {
    margin: 0;
    font-size: 0.92rem;
    font-weight: 600;
    color: var(--text-strong);
}
.section-desc {
    margin: 0;
    font-size: 0.85rem;
    color: var(--text-muted);
    line-height: 1.5;
}
.section-action { display: flex; }

/* RPC scope approval */
.scope-empty { font-style: italic; }
.scope-summary {
    margin: 0;
    font-size: 0.82rem;
    color: var(--text-muted);
}
.scope-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
}
.scope-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    padding: 0.3rem 0.5rem;
    background: var(--bg-page);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
}
.scope-label {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    cursor: pointer;
    user-select: none;
    min-width: 0;
}
.scope-checkbox {
    width: 15px;
    height: 15px;
    flex-shrink: 0;
    cursor: pointer;
    accent-color: var(--accent);
}
.scope-code {
    font-family: var(--font-mono, monospace);
    font-size: 0.82rem;
    color: var(--text-strong);
    overflow-wrap: anywhere;
}
.pending-badge {
    flex-shrink: 0;
    padding: 0.05rem 0.4rem;
    font-size: 0.72rem;
    font-weight: 600;
    border-radius: var(--radius-sm);
    color: var(--warning, #d97706);
    background: color-mix(in srgb, var(--warning, #d97706) 13%, var(--bg-surface));
    border: 1px solid color-mix(in srgb, var(--warning, #d97706) 35%, transparent);
}
.scope-actions {
    display: flex;
    gap: 0.5rem;
    align-items: center;
}
.ghost-btn {
    padding: 0.35rem 0.75rem;
    font-size: 0.82rem;
    font-weight: 500;
    border-radius: var(--radius-sm);
    background: none;
    color: var(--text);
    border: 1px solid var(--border);
    cursor: pointer;
    transition: background 0.12s, border-color 0.12s;
}
.ghost-btn:hover { background: var(--bg-surface-hover, var(--bg-page)); }
.primary-btn {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    padding: 0.35rem 0.85rem;
    font-size: 0.82rem;
    font-weight: 500;
    border-radius: var(--radius-sm);
    background: var(--accent);
    color: var(--text-on-accent);
    border: none;
    cursor: pointer;
    transition: opacity 0.12s, background 0.12s;
}
.primary-btn:disabled { opacity: 0.45; cursor: not-allowed; }
.primary-btn.saved {
    background: color-mix(in srgb, var(--success, #16a34a) 80%, black 0%);
}
.scope-error {
    margin: 0;
    font-size: 0.82rem;
    color: var(--danger, #dc2626);
}
.danger-btn {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    padding: 0.35rem 0.75rem;
    font-size: 0.82rem;
    font-weight: 500;
    border-radius: var(--radius-sm);
    background: none;
    color: var(--danger, #dc2626);
    border: 1px solid color-mix(in srgb, var(--danger, #dc2626) 45%, transparent);
    cursor: pointer;
    transition: background 0.12s, border-color 0.12s;
}
.danger-btn:hover {
    background: color-mix(in srgb, var(--danger, #dc2626) 9%, var(--bg-surface));
    border-color: color-mix(in srgb, var(--danger, #dc2626) 65%, transparent);
}

/* Secret result modal */
.secret-result-body {
    padding: 0.9rem 1rem 0.75rem;
    display: flex;
    flex-direction: column;
    gap: 0.7rem;
}
.secret-result-label {
    margin: 0;
    font-size: 0.82rem;
    font-weight: 600;
    color: var(--text-strong);
}
.secret-input-row {
    display: flex;
    gap: 0.4rem;
    align-items: stretch;
}
.secret-input {
    flex: 1;
    min-width: 0;
    padding: 0.4rem 0.6rem;
    font-family: var(--font-mono, monospace);
    font-size: 0.82rem;
    letter-spacing: 0.02em;
    background: var(--bg-page);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-strong);
    cursor: text;
    user-select: all;
}
.secret-input:focus {
    outline: 2px solid var(--accent);
    outline-offset: -1px;
}
.copy-btn {
    display: inline-flex;
    align-items: center;
    gap: 0.22rem;
    flex-shrink: 0;
    padding: 0.35rem 0.7rem;
    font-size: 0.8rem;
    font-weight: 500;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border);
    background: var(--bg-surface);
    color: var(--text);
    cursor: pointer;
    transition: background 0.12s, color 0.12s, border-color 0.12s;
}
.copy-btn:hover { background: var(--bg-surface-hover, var(--bg-page)); }
.copy-btn.copied {
    background: color-mix(in srgb, var(--success, #16a34a) 14%, var(--bg-surface));
    color: var(--success, #16a34a);
    border-color: color-mix(in srgb, var(--success, #16a34a) 35%, transparent);
}
.secret-instruction { margin: 0; font-size: 0.82rem; color: var(--text-muted); }
.secret-env-hint {
    background: var(--bg-page);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 0.5rem 0.7rem;
    overflow-x: auto;
}
.secret-env-hint code {
    font-family: var(--font-mono, monospace);
    font-size: 0.82rem;
    color: var(--text-strong);
    white-space: nowrap;
}
.secret-warning {
    display: flex;
    align-items: flex-start;
    gap: 0.35rem;
    padding: 0.5rem 0.65rem;
    background: color-mix(in srgb, var(--warning, #d97706) 11%, var(--bg-surface));
    border: 1px solid color-mix(in srgb, var(--warning, #d97706) 35%, transparent);
    border-radius: var(--radius-sm);
    font-size: 0.82rem;
    color: var(--warning, #d97706);
    line-height: 1.45;
}
.secret-warning-icon { flex-shrink: 0; margin-top: 0.1rem; }
.secret-ack-label {
    display: flex;
    align-items: center;
    gap: 0.45rem;
    font-size: 0.85rem;
    color: var(--text);
    cursor: pointer;
    user-select: none;
}
.secret-ack-checkbox {
    width: 15px;
    height: 15px;
    flex-shrink: 0;
    cursor: pointer;
    accent-color: var(--accent);
}
.secret-result-actions {
    display: flex;
    justify-content: flex-end;
    padding-top: 0.25rem;
    border-top: 1px solid var(--border);
}
.secret-result-actions .primary {
    padding: 0.4rem 0.85rem;
    background: var(--accent);
    color: var(--text-on-accent);
    border: none;
    border-radius: var(--radius-sm);
    cursor: pointer;
    font-size: 0.85rem;
    font-weight: 500;
}
.secret-result-actions .primary:disabled {
    opacity: 0.45;
    cursor: not-allowed;
}
</style>

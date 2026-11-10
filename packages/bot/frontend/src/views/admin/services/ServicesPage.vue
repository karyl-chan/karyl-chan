<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { RouterLink } from 'vue-router';
import { Icon } from '@iconify/vue';
import { AppButton, Stack, useConfirm, useToastStore } from '@karyl-chan/ui';
import { isStale } from '../behaviors/behavior-errors';
import {
    createService,
    deleteService,
    listServices,
    updateService,
    type ServiceInput,
    type ServiceView,
} from '../../../api/services';
import ServiceFields from './ServiceFields.vue';
import {
    NO_SERVICE_ERRORS,
    checkServiceDraft,
    draftOfService,
    emptyServiceDraft,
    hasServiceErrors,
    serviceBody,
    serviceErrorsFromRefusal,
    servicePatch,
    type ServiceFormErrors,
} from './service-draft';

/**
 * The services page (#126): the self-hosted services that log their users
 * in through karyl. Each has a name, an audience (the token's `aud`) and
 * a redirect URL; adding one also adds its Service Behavior — a bot DM
 * trigger on `!login-<audience>` — whose trigger (who may log in) is set on
 * the behaviors page. Removing a service removes that behavior too. Owner
 * only (router meta and the API): whoever sets a redirect URL receives the
 * tokens of everyone who logs in there.
 */

const { t } = useI18n();
const { confirm } = useConfirm();
const toast = useToastStore();

const services = ref<ServiceView[]>([]);
const loading = ref(false);
const error = ref<string | null>(null);

/** Where services fetch the public keys from. */
const jwksUrl = computed(() => `${window.location.origin}/.well-known/jwks.json`);

async function load() {
    loading.value = true;
    error.value = null;
    try {
        services.value = await listServices();
    } catch (err) {
        error.value = err instanceof Error ? err.message : String(err);
    } finally {
        loading.value = false;
    }
}
onMounted(load);

// ── add ─────────────────────────────────────────────────────────────────────

const adding = ref(false);
const addDraft = ref<ServiceInput>(emptyServiceDraft());
const addErrors = ref<ServiceFormErrors>(NO_SERVICE_ERRORS);
const addSaving = ref(false);

function startAdd() {
    addDraft.value = emptyServiceDraft();
    addErrors.value = NO_SERVICE_ERRORS;
    adding.value = true;
}

async function submitAdd() {
    const found = checkServiceDraft(t, addDraft.value);
    addErrors.value = found;
    if (hasServiceErrors(found)) return;
    addSaving.value = true;
    try {
        const created = await createService(serviceBody(addDraft.value));
        services.value = [...services.value, created];
        adding.value = false;
        toast.show(t('services.created', { name: created.name }), 'success');
    } catch (err) {
        addErrors.value = serviceErrorsFromRefusal(err);
    } finally {
        addSaving.value = false;
    }
}

// ── edit ────────────────────────────────────────────────────────────────────

const editingId = ref<number | null>(null);
const editDraft = ref<ServiceInput>(emptyServiceDraft());
const editErrors = ref<ServiceFormErrors>(NO_SERVICE_ERRORS);
const editSaving = ref(false);

function startEdit(service: ServiceView) {
    editingId.value = service.id;
    editDraft.value = draftOfService(service);
    editErrors.value = NO_SERVICE_ERRORS;
}

async function submitEdit(service: ServiceView) {
    const found = checkServiceDraft(t, editDraft.value);
    editErrors.value = found;
    if (hasServiceErrors(found)) return;
    const patch = servicePatch(service, editDraft.value);
    if (!patch) {
        editingId.value = null;
        return;
    }
    editSaving.value = true;
    try {
        const saved = await updateService(service.id, patch);
        services.value = services.value.map((s) => (s.id === saved.id ? saved : s));
        editingId.value = null;
    } catch (err) {
        if (isStale(err)) {
            // someone changed it since the list was loaded: show theirs, keep nothing stale
            editingId.value = null;
            toast.show(t('services.stale'), 'warn');
            await load();
        } else {
            editErrors.value = serviceErrorsFromRefusal(err);
        }
    } finally {
        editSaving.value = false;
    }
}

// ── delete ──────────────────────────────────────────────────────────────────

async function remove(service: ServiceView) {
    const ok = await confirm({
        title: t('services.deleteTitle'),
        message: t('services.deleteMessage', { name: service.name }),
        confirmLabel: t('services.delete'),
        confirmVariant: 'danger',
        cancelLabel: t('common.cancel'),
    });
    if (!ok) return;
    try {
        await deleteService(service.id);
        services.value = services.value.filter((s) => s.id !== service.id);
    } catch (err) {
        toast.show(err instanceof Error ? err.message : String(err));
    }
}

function triggerText(service: ServiceView): string {
    const trigger = service.trigger;
    if (!trigger) return t('services.noTrigger');
    if (trigger.kind === 'command') return `/${trigger.name}`;
    if (!trigger.patternKind) return t('services.noTrigger');
    return t(`behaviors.card.pattern.${trigger.patternKind}`, { value: trigger.patternValue ?? '' });
}
</script>

<template>
    <div class="page">
        <header class="page-head">
            <div class="page-head-text">
                <h1 class="title">{{ t('services.title') }}</h1>
                <p class="subtitle">{{ t('services.subtitle') }}</p>
            </div>
            <AppButton size="sm" icon="material-symbols:add-rounded" data-test="add-service" :disabled="adding" @click="startAdd">
                {{ t('services.add') }}
            </AppButton>
        </header>

        <p class="jwks" data-test="jwks">
            {{ t('services.jwks') }}
            <code>{{ jwksUrl }}</code>
        </p>

        <form v-if="adding" class="panel" data-test="add-form" @submit.prevent="submitAdd">
            <Stack gap="3">
                <h2 class="panel-title">{{ t('services.addTitle') }}</h2>
                <ServiceFields :draft="addDraft" :errors="addErrors.fields" @patch="addDraft = { ...addDraft, ...$event }" />
                <p class="hint">{{ t('services.addHint', { trigger: `!login-${addDraft.audience.trim() || t('services.field.audiencePlaceholder')}` }) }}</p>
                <p v-if="addErrors.general" class="error" role="alert">{{ addErrors.general }}</p>
                <footer class="footer">
                    <AppButton variant="secondary" @click="adding = false">{{ t('common.cancel') }}</AppButton>
                    <AppButton type="submit" data-test="add-submit" :loading="addSaving">{{ t('services.add') }}</AppButton>
                </footer>
            </Stack>
        </form>

        <div v-if="error" class="error-banner" role="alert">
            <span>{{ error }}</span>
            <AppButton size="sm" variant="ghost" @click="load">{{ t('common.refresh') }}</AppButton>
        </div>
        <p v-else-if="loading && services.length === 0" class="muted center">{{ t('common.loading') }}</p>
        <p v-else-if="services.length === 0 && !adding" class="muted center" data-test="empty">{{ t('services.empty') }}</p>

        <ul class="list">
            <li v-for="service in services" :key="service.id" class="panel" data-test="service-row">
                <form v-if="editingId === service.id" @submit.prevent="submitEdit(service)">
                    <Stack gap="3">
                        <ServiceFields :draft="editDraft" :errors="editErrors.fields" @patch="editDraft = { ...editDraft, ...$event }" />
                        <p v-if="editDraft.audience.trim() !== service.audience" class="hint" data-test="audience-warning">
                            {{ t('services.audienceChange') }}
                        </p>
                        <p v-if="editErrors.general" class="error" role="alert">{{ editErrors.general }}</p>
                        <footer class="footer">
                            <AppButton variant="secondary" @click="editingId = null">{{ t('common.cancel') }}</AppButton>
                            <AppButton type="submit" data-test="edit-submit" :loading="editSaving">{{ t('common.save') }}</AppButton>
                        </footer>
                    </Stack>
                </form>
                <template v-else>
                    <div class="row-head">
                        <Icon icon="material-symbols:key-outline-rounded" width="18" height="18" class="row-icon" aria-hidden="true" />
                        <span class="name">{{ service.name }}</span>
                        <code class="audience">{{ service.audience }}</code>
                        <span class="spacer" />
                        <AppButton size="sm" variant="ghost" data-test="edit" @click="startEdit(service)">
                            {{ t('services.edit') }}
                        </AppButton>
                        <AppButton size="sm" variant="ghost" data-test="delete" @click="remove(service)">
                            {{ t('services.delete') }}
                        </AppButton>
                    </div>
                    <dl class="details">
                        <dt>{{ t('services.field.redirectUrl') }}</dt>
                        <dd><code class="url">{{ service.redirectUrl }}</code></dd>
                        <dt>{{ t('services.trigger') }}</dt>
                        <dd>
                            <span class="mono" data-test="trigger">{{ triggerText(service) }}</span>
                            ·
                            <RouterLink to="/admin/behaviors">{{ t('services.editTrigger') }}</RouterLink>
                        </dd>
                    </dl>
                </template>
            </li>
        </ul>
    </div>
</template>

<style scoped>
.page {
    display: flex;
    flex-direction: column;
    gap: 0.85rem;
    padding: 0.75rem;
    height: 100%;
    overflow-y: auto;
}
.page-head { display: flex; align-items: flex-start; gap: 0.5rem; flex-wrap: wrap; }
.page-head-text { flex: 1; min-width: 12rem; }
.title { margin: 0; font-size: 1.1rem; color: var(--text-strong); }
.subtitle { margin: 0.2rem 0 0; color: var(--text-muted); font-size: 0.83rem; line-height: 1.6; }
.jwks { margin: 0; font-size: 0.82rem; color: var(--text-muted); overflow-wrap: anywhere; }
.panel {
    padding: 0.75rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg-surface, var(--bg-page));
    list-style: none;
}
.panel-title { margin: 0; font-size: 0.95rem; color: var(--text-strong); }
.list { display: flex; flex-direction: column; gap: 0.5rem; margin: 0; padding: 0; }
.row-head { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; }
.row-icon { color: var(--text-muted); }
.name { font-weight: 600; color: var(--text-strong); }
.audience { font-size: 0.8rem; color: var(--text-muted); }
.spacer { flex: 1; }
.details {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 0.35rem 0.75rem;
    margin: 0.5rem 0 0;
    font-size: 0.85rem;
}
dt { color: var(--text-muted); }
dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
.url, .mono { font-family: var(--font-mono, ui-monospace, monospace); font-size: 0.8rem; }
.hint { margin: 0; font-size: 0.78rem; color: var(--text-muted); line-height: 1.6; }
.error { margin: 0; font-size: 0.82rem; color: var(--danger); }
.error-banner { display: flex; align-items: center; gap: 0.5rem; color: var(--danger); font-size: 0.9rem; }
.muted { color: var(--text-muted); }
.center { padding: 1rem; text-align: center; }
.footer { display: flex; justify-content: flex-end; gap: 0.5rem; }
</style>

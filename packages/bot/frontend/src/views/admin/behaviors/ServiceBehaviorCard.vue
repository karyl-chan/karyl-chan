<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { RouterLink } from 'vue-router';
import { Icon } from '@iconify/vue';
import { AppBadge, AppButton, AppItemCard, AppToggle, Stack } from '@karyl-chan/ui';
import { updateServiceTrigger, type ServiceBehaviorView } from '../../../api/behavior';
import GroupMembersPanel from './GroupMembersPanel.vue';
import MessageTriggerFields from './MessageTriggerFields.vue';
import { NO_ERRORS, errorsFromRefusal, isStale, type FormErrors } from './behavior-errors';
import { previewMatch } from './message-trigger-draft';
import { SERVICE_TRIGGER_FIELDS, serviceTriggerDraftModel } from './service-trigger-draft';
import { draftLeavesGroup, useSoleGroup } from './use-sole-group';
import { useDraftForm } from './use-draft-form';

/**
 * A Service Behavior (#126): the row a service on the services page owns.
 * Its action is fixed — log the triggerer in to the service — and so is
 * where it lives (a bot DM that ends the walk); the admin changes only its
 * trigger: the pattern, and the audience, which is who may log in. The
 * service itself (name, audience, redirect URL) and its removal are on
 * the services page. Locked like the System Behavior: no toggle, no
 * delete, no conversion.
 */
const props = defineProps<{
    behavior: ServiceBehaviorView;
    expand?: boolean;
    /** Audience Groups in use, sorted, and how many triggers use each. */
    groupNames: readonly string[];
    groupUse: ReadonlyMap<string, number>;
}>();

const emit = defineEmits<{
    (e: 'updated', behavior: ServiceBehaviorView): void;
    /** The list is out of date (a stale write was refused). */
    (e: 'reload'): void;
}>();

const { t } = useI18n();

const open = ref(props.expand ?? false);
watch(
    () => props.expand,
    (expand) => {
        if (expand) open.value = true;
    }
);

const form = useDraftForm(serviceTriggerDraftModel, () => props.behavior, `service-behavior:${props.behavior.id}`);
const { base, draft, conflict, stale, dirty, applyPatch, keepMine } = form;

const errors = ref<FormErrors>(NO_ERRORS);
const saving = ref(false);
const canSave = computed(() => dirty.value && !saving.value && !conflict.value);

function discard() {
    form.discard();
    errors.value = NO_ERRORS;
}

async function save() {
    const patch = serviceTriggerDraftModel.patchOf(base.value, draft.value);
    if (!patch || !canSave.value) return;
    if (draft.value.patternKind === 'regex' && previewMatch('regex', draft.value.patternValue, '') === 'invalid') {
        errors.value = { fields: { patternValue: t('behaviors.trigger.preview.invalid') }, general: null };
        return;
    }
    saving.value = true;
    stale.value = false;
    try {
        const { behavior } = await updateServiceTrigger(props.behavior.id, patch);
        errors.value = NO_ERRORS;
        form.adopt(behavior);
        emit('updated', behavior);
    } catch (err) {
        if (isStale(err)) {
            form.refusedAsStale();
            errors.value = NO_ERRORS;
            emit('reload');
        } else {
            errors.value = errorsFromRefusal(t, err, SERVICE_TRIGGER_FIELDS);
        }
    } finally {
        saving.value = false;
    }
}

// ── the sole user of a group: its member list goes with it ─────────────────

const soleGroup = useSoleGroup(base, () => props.groupUse, open);
const groupDropWarning = computed(() => {
    const group = soleGroup.group.value;
    const count = soleGroup.members.value ?? 0;
    return group && count > 0 && draftLeavesGroup(group, draft.value)
        ? t('behaviors.group.dropOnSave', { group, count })
        : '';
});
const savedGroup = computed(() =>
    base.value.audienceKind === 'group' &&
    draft.value.audienceKind === 'group' &&
    draft.value.audienceGroupName.trim() === base.value.audienceGroupName
        ? base.value.audienceGroupName
        : null
);

const patternSummary = computed(() =>
    t(`behaviors.card.pattern.${props.behavior.patternKind}`, { value: props.behavior.patternValue })
);
</script>

<template>
    <AppItemCard :expanded="open" accent-bar="neutral" data-test="service-behavior" @update:expanded="open = $event">
        <template #leading>
            <span class="lead" :title="t('behaviors.service.locked')">
                <Icon icon="material-symbols:key-outline-rounded" width="16" height="16" aria-hidden="true" />
            </span>
        </template>

        <template #title>
            <span class="title">{{ behavior.title }}</span>
            <span class="summary" data-test="service-summary">{{ patternSummary }}</span>
        </template>

        <template #trailing>
            <AppBadge v-if="dirty" size="sm" tone="warn" icon="material-symbols:edit-outline-rounded">
                {{ t('behaviors.card.unsaved') }}
            </AppBadge>
            <AppBadge size="sm" icon="material-symbols:key-outline-rounded" :title="t('behaviors.service.tag')">
                {{ t('behaviors.service.tagShort') }}
            </AppBadge>
            <AppToggle
                :model-value="true"
                disabled
                :title="t('behaviors.service.toggleProtected')"
                :aria-label="t('behaviors.service.toggleProtected')"
            />
        </template>

        <form class="editor" data-test="service-trigger-form" @submit.prevent="save">
            <Stack gap="3">
                <p class="notice" role="note">
                    {{ t('behaviors.service.notice') }}
                    <RouterLink to="/admin/services" data-test="services-link">{{ t('behaviors.service.manage') }}</RouterLink>
                </p>

                <MessageTriggerFields
                    :draft="draft"
                    :kinds="['bot_dm']"
                    :errors="errors.fields"
                    :group-names="groupNames"
                    fixed-placement
                    @patch="applyPatch"
                >
                    <template #group-members>
                        <GroupMembersPanel
                            v-if="savedGroup"
                            :group-name="savedGroup"
                            :used-by="groupUse.get(savedGroup) ?? 1"
                            @members="soleGroup.members.value = $event"
                        />
                        <p v-else class="hint">{{ t('behaviors.group.saveFirst') }}</p>
                    </template>
                </MessageTriggerFields>

                <dl class="details">
                    <dt>{{ t('behaviors.card.action') }}</dt>
                    <dd data-test="service-action">
                        {{ t('behaviors.service.action', { name: behavior.service.name }) }}
                    </dd>
                    <dt>{{ t('behaviors.service.audience') }}</dt>
                    <dd><code>{{ behavior.service.audience }}</code></dd>
                    <dt>{{ t('behaviors.service.redirectUrl') }}</dt>
                    <dd><code class="url">{{ behavior.service.redirectUrl }}</code></dd>
                </dl>

                <p v-if="groupDropWarning" class="warning" role="status" data-test="group-drop">{{ groupDropWarning }}</p>

                <div v-if="conflict" class="conflict" role="alert" data-test="conflict">
                    <span>{{ t('behaviors.card.conflict') }}</span>
                    <AppButton size="sm" variant="secondary" @click="keepMine">{{ t('behaviors.card.conflictKeep') }}</AppButton>
                    <AppButton size="sm" variant="ghost" @click="discard">{{ t('behaviors.card.conflictDiscard') }}</AppButton>
                </div>
                <p v-else-if="stale" class="hint" role="status">{{ t('behaviors.card.staleRebased') }}</p>
                <p v-if="errors.general" class="error" role="alert" data-test="general-error">{{ errors.general }}</p>

                <footer class="footer">
                    <AppButton variant="secondary" :disabled="!dirty || saving" @click="discard">
                        {{ t('common.cancel') }}
                    </AppButton>
                    <AppButton type="submit" data-test="save" :loading="saving" :disabled="!canSave">
                        {{ t('common.save') }}
                    </AppButton>
                </footer>
            </Stack>
        </form>
    </AppItemCard>
</template>

<style scoped>
.lead { color: var(--text-muted); display: inline-flex; align-items: center; padding: 0.25rem; }
.title {
    font-weight: 600;
    color: var(--text-strong);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex-shrink: 0;
    max-width: 50%;
}
.summary {
    color: var(--text-muted);
    font-size: 0.8rem;
    font-family: var(--font-mono, ui-monospace, monospace);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
}
.notice {
    margin: 0;
    padding: 0.5rem 0.7rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    font-size: 0.85rem;
    color: var(--text-muted);
    line-height: 1.6;
}
.details {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 0.35rem 0.75rem;
    margin: 0;
    font-size: 0.85rem;
}
dt { color: var(--text-muted); }
dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
.url { font-size: 0.8rem; }
.hint { margin: 0; font-size: 0.78rem; color: var(--text-muted); }
.warning { margin: 0; font-size: 0.82rem; color: var(--warn-text, var(--text)); }
.conflict {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 0.7rem;
    border: 1px solid var(--warn-text, var(--border));
    border-radius: var(--radius-sm);
    font-size: 0.85rem;
}
.conflict span { flex: 1; min-width: 12rem; }
.error { margin: 0; font-size: 0.82rem; color: var(--danger); }
.footer {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
    padding-top: 0.75rem;
    border-top: 1px solid var(--border);
}
</style>

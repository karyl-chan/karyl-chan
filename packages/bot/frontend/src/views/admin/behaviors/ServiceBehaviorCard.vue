<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { RouterLink } from 'vue-router';
import { Icon } from '@iconify/vue';
import { AppBadge, AppButton, AppItemCard, AppTextField, AppToggle, Stack } from '@karyl-chan/ui';
import { switchServiceTrigger, type ServiceBehaviorView } from '../../../api/behavior';
import { useCurrentUserStore } from '../../../stores/currentUserStore';
import CommandRegistrationResult from './CommandRegistrationResult.vue';
import CommandVisibilityFields from './CommandVisibilityFields.vue';
import GroupMembersPanel from './GroupMembersPanel.vue';
import MessageTriggerFields from './MessageTriggerFields.vue';
import TriggerKindMenu from './TriggerKindMenu.vue';
import { NO_ERRORS, errorsFromRefusal, hasErrors, isStale, type FormErrors } from './behavior-errors';
import type { CommandDraft } from './command-draft';
import { isRegistrationRefusal, registrationFailure, registrationResult } from './registration-result';
import { sectionLabel } from './section-labels';
import {
    serviceCommandDraftOf,
    serviceDraftSection,
    serviceTriggerDraftErrors,
    serviceTriggerDraftModel,
    serviceTriggerFields,
    serviceTriggerPatch,
} from './service-trigger-draft';
import { useDraftForm } from './use-draft-form';
import { draftLeavesGroup, useSoleGroup } from './use-sole-group';
import { useRegistrationResult } from './use-registration-results';

/**
 * A Service Behavior (#126): the row a service on the services page owns.
 * Locked like the System Behavior — no toggle, no delete, no other action:
 * its action logs the triggerer in to the service. Its trigger is the one
 * thing the owner changes, as for the login: a bot DM pattern with an
 * audience (who may log in) or a global command, the kind switched from
 * the title row's tag and saved through the login's switch (the new
 * trigger first, PUT /api/services/:id/trigger). A command moves the card
 * to the section its visibility puts it in, still under 服務. Only a bot
 * owner may change it — whoever controls a service's login controls who
 * gets its tokens — so for anyone else the card is read-only.
 */
const props = defineProps<{
    behavior: ServiceBehaviorView;
    expand?: boolean;
    guildNames: ReadonlyMap<string, string>;
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
const currentUser = useCurrentUserStore();
const isOwner = computed(() => currentUser.user?.isOwner === true);

const open = ref(props.expand ?? false);
watch(
    () => props.expand,
    (expand) => {
        if (expand) open.value = true;
    }
);

const form = useDraftForm(serviceTriggerDraftModel, () => props.behavior, `service-behavior:${props.behavior.service.id}`);
const { base, draft, conflict, stale, dirty, applyPatch, keepMine } = form;

/** Kept by the page under a key no command has: a switch moves the card. */
const registration = useRegistrationResult(() => -props.behavior.service.id);

const errors = ref<FormErrors>(NO_ERRORS);
const saving = ref(false);
const canSave = computed(() => isOwner.value && dirty.value && !saving.value && !conflict.value);

function discard() {
    form.discard();
    errors.value = NO_ERRORS;
}

async function save() {
    const patch = serviceTriggerPatch(base.value, draft.value);
    if (!patch || !canSave.value) return;
    const found = serviceTriggerDraftErrors(t, draft.value);
    errors.value = found;
    if (hasErrors(found)) return;
    saving.value = true;
    stale.value = false;
    registration.value = null;
    try {
        const result = await switchServiceTrigger(props.behavior.service.id, patch);
        form.adopt(result.behavior);
        if (result.registration) registration.value = registrationResult(t, result.registration, props.guildNames);
        emit('updated', result.behavior);
    } catch (err) {
        if (isStale(err)) {
            form.refusedAsStale();
            errors.value = NO_ERRORS;
            emit('reload');
        } else if (isRegistrationRefusal(err)) {
            errors.value = NO_ERRORS;
            registration.value = registrationFailure(t, err, props.guildNames);
        } else {
            errors.value = errorsFromRefusal(t, err, serviceTriggerFields(draft.value));
        }
    } finally {
        saving.value = false;
    }
}

/** The tag's other kind: the draft turns to it (the other half holds its defaults); saving switches. */
function switchKind(kind: 'message' | 'command') {
    if (!isOwner.value) return;
    errors.value = NO_ERRORS;
    applyPatch({ kind });
}

// ── the message half's audience group ───────────────────────────────────────

/** The saved trigger's audience: a command has none. */
const savedAudience = computed(() =>
    base.value.kind === 'message'
        ? { audienceKind: base.value.audienceKind, audienceGroupName: base.value.audienceGroupName }
        : { audienceKind: 'all' as const, audienceGroupName: null }
);
/** The sole user of a group: saving away from it (another audience, a command) drops its list. */
const soleGroup = useSoleGroup(savedAudience, () => props.groupUse, open);
const groupDropWarning = computed(() => {
    const group = soleGroup.group.value;
    const count = soleGroup.members.value ?? 0;
    const leaves = group !== null && (draft.value.kind === 'command' || draftLeavesGroup(group, draft.value));
    return group && count > 0 && leaves ? t('behaviors.group.dropOnSave', { group, count }) : '';
});

const savedGroup = computed(() =>
    base.value.kind === 'message' &&
    base.value.audienceKind === 'group' &&
    draft.value.audienceKind === 'group' &&
    draft.value.audienceGroupName.trim() === base.value.audienceGroupName
        ? base.value.audienceGroupName
        : null
);

// ── the command half ────────────────────────────────────────────────────────

const visibilityDraft = computed<CommandDraft>(() => serviceCommandDraftOf(draft.value));
function patchVisibility(patch: Partial<CommandDraft>) {
    const next: Partial<typeof draft.value> = {};
    if (patch.integrationTypes) next.integrationTypes = patch.integrationTypes;
    if (patch.contexts) next.contexts = patch.contexts;
    applyPatch(next);
}

// ── view ────────────────────────────────────────────────────────────────────

const title = computed(() =>
    props.behavior.kind === 'command' ? (props.behavior.leaves[0]?.title ?? '') : props.behavior.title
);
const summary = computed(() =>
    props.behavior.kind === 'command'
        ? `/${props.behavior.name}`
        : t(`behaviors.card.pattern.${props.behavior.patternKind}`, { value: props.behavior.patternValue })
);
/** Where saving would move the card, when that is another section. */
const moved = computed(() => {
    const target = serviceDraftSection(draft.value);
    return dirty.value && target !== props.behavior.section ? sectionLabel(t, target, props.guildNames) : null;
});
const kindBlocked = computed(() => (isOwner.value ? null : t('behaviors.service.ownerOnly')));
</script>

<template>
    <AppItemCard :expanded="open" accent-bar="neutral" data-test="service-behavior" @update:expanded="open = $event">
        <template #leading>
            <span class="lead" :title="t('behaviors.service.locked')">
                <Icon icon="material-symbols:key-outline-rounded" width="16" height="16" aria-hidden="true" />
            </span>
        </template>

        <template #title>
            <span class="title">{{ title }}</span>
            <span class="summary" data-test="service-summary">{{ summary }}</span>
        </template>

        <template #trailing>
            <AppBadge v-if="dirty" size="sm" tone="warn" icon="material-symbols:edit-outline-rounded">
                {{ t('behaviors.card.unsaved') }}
            </AppBadge>
            <TriggerKindMenu :kind="draft.kind" :blocked="kindBlocked" @convert="switchKind" />
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
                    <RouterLink v-if="isOwner" to="/admin/services" data-test="services-link">{{ t('behaviors.service.manage') }}</RouterLink>
                </p>
                <p v-if="!isOwner" class="notice" role="note" data-test="owner-only">{{ t('behaviors.service.ownerOnly') }}</p>
                <CommandRegistrationResult v-if="registration" :result="registration" @dismiss="registration = null" />

                <fieldset class="trigger" :disabled="!isOwner">
                    <MessageTriggerFields
                        v-if="draft.kind === 'message'"
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
                                :readonly="!isOwner"
                                @members="soleGroup.members.value = $event"
                            />
                            <p v-else class="hint">{{ t('behaviors.group.saveFirst') }}</p>
                        </template>
                    </MessageTriggerFields>

                    <Stack v-else gap="3">
                        <h4 class="part">{{ t('behaviors.trigger.title') }}</h4>
                        <div class="grid">
                            <AppTextField
                                class="mono"
                                data-test="service-command-name"
                                :model-value="draft.name"
                                :label="t('behaviors.system.commandName')"
                                :hint="t('behaviors.command.nameHint')"
                                :error="errors.fields.name"
                                @update:model-value="applyPatch({ name: String($event) })"
                            />
                            <AppTextField
                                :model-value="draft.commandDescription"
                                :label="t('behaviors.system.commandDescription')"
                                :hint="t('behaviors.command.descriptionHint')"
                                :error="errors.fields.description"
                                @update:model-value="applyPatch({ commandDescription: String($event) })"
                            />
                        </div>
                        <CommandVisibilityFields
                            :draft="visibilityDraft"
                            :errors="errors.fields"
                            :section="behavior.section"
                            :guild-names="guildNames"
                            global-only
                            @patch="patchVisibility"
                        />
                        <p class="warning" role="note" data-test="command-warning">{{ t('behaviors.service.commandNote') }}</p>
                    </Stack>
                </fieldset>
                <p v-if="groupDropWarning" class="warning" role="status" data-test="group-drop">{{ groupDropWarning }}</p>
                <p v-if="moved" class="hint" role="status" data-test="moved">{{ t('behaviors.trigger.moved', { section: moved }) }}</p>

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

                <div v-if="conflict" class="conflict" role="alert" data-test="conflict">
                    <span>{{ t('behaviors.card.conflict') }}</span>
                    <AppButton size="sm" variant="secondary" @click="keepMine">{{ t('behaviors.card.conflictKeep') }}</AppButton>
                    <AppButton size="sm" variant="ghost" @click="discard">{{ t('behaviors.card.conflictDiscard') }}</AppButton>
                </div>
                <p v-else-if="stale" class="hint" role="status">{{ t('behaviors.card.staleRebased') }}</p>
                <p v-if="errors.general" class="error" role="alert" data-test="general-error">{{ errors.general }}</p>

                <footer v-if="isOwner" class="footer">
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
.trigger { border: 0; margin: 0; padding: 0; min-width: 0; }
.part {
    margin: 0.2rem 0 0;
    padding-bottom: 0.25rem;
    border-bottom: 1px solid var(--border);
    font-size: 0.78rem;
    font-weight: 600;
    color: var(--text-muted);
}
.grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr));
    gap: 0.6rem 1rem;
}
.mono :deep(input) { font-family: var(--font-mono, ui-monospace, monospace); }
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
.hint { margin: 0; font-size: 0.78rem; color: var(--text-muted); line-height: 1.6; }
.warning { margin: 0; font-size: 0.82rem; color: var(--warn-text, var(--text)); line-height: 1.6; }
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

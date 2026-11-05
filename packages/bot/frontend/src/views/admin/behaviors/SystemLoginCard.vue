<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Icon } from '@iconify/vue';
import {
    AppBadge,
    AppButton,
    AppItemCard,
    AppSelectField,
    AppTextField,
    AppToggle,
    Stack,
    type SelectOption,
} from '@karyl-chan/ui';
import {
    getBehaviorSchemas,
    resyncBehaviorCommand,
    switchLoginTrigger,
    type BehaviorItemView,
    type LoginPatternKind,
    type RegistrationReport,
} from '../../../api/behavior';
import { useCurrentUserStore } from '../../../stores/currentUserStore';
import BehaviorActionDetails from './BehaviorActionDetails.vue';
import BehaviorSourceNotice from './BehaviorSourceNotice.vue';
import CommandRegistrationResult from './CommandRegistrationResult.vue';
import CommandVisibilityFields from './CommandVisibilityFields.vue';
import LoginTriggerSwitchDialog from './LoginTriggerSwitchDialog.vue';
import { NO_ERRORS, errorsFromRefusal, hasErrors, isStale, type FormErrors } from './behavior-errors';
import type { CommandDraft } from './command-draft';
import {
    LOGIN_COMMAND_REQUIRED,
    LOGIN_PATTERN_KINDS,
    loginCommandDraftOf,
    loginTriggerDraftErrors,
    loginTriggerDraftOf,
    loginTriggerDraftModel,
    loginTriggerFields,
    loginTriggerPatch,
    loginTriggerText,
    switchesKind,
    type LoginTriggerDraft,
} from './login-trigger-draft';
import { previewMatch } from './message-trigger-draft';
import {
    isRegistrationRefusal,
    registrationFailure,
    registrationResult,
    type RegistrationResult,
} from './registration-result';
import { useDraftForm } from './use-draft-form';
import { useRegistrationResult } from './use-registration-results';

/**
 * The System Behavior — the login — pinned on top of its section, locked
 * (board 3). It cannot be deleted, disabled or given another action; its
 * trigger is the one thing an admin changes: a message pattern in DMs
 * with the bot, or a global command. Switching between the two goes
 * through board 4's confirm (LoginTriggerSwitchDialog), which runs the
 * switch and shows each step; a change within the same kind saves
 * directly, a command's with what Discord answered. On a command it can
 * also be registered again as stored (resync), for when Discord lost it.
 *
 * A message save needs a sample DM the pattern matches (the server checks
 * it again), and a command always keeps guild install and bot DMs — both
 * so a save cannot lock the owner out. Only a bot owner may change any of
 * it: for anyone else the card is read-only and says so.
 */
const props = defineProps<{
    system: BehaviorItemView;
    /** Open the card (and bring it into view) — e.g. right after the switch moved it here. */
    expand?: boolean;
    guildNames: ReadonlyMap<string, string>;
}>();

const emit = defineEmits<{
    (e: 'updated', system: BehaviorItemView): void;
    /** The list is out of date (a stale write was refused). */
    (e: 'reload'): void;
}>();

const { t } = useI18n();
const currentUser = useCurrentUserStore();
/** The server refuses anyone else (requireOwner); the card does not offer it to them. */
const isOwner = computed(() => currentUser.user?.isOwner === true);

const open = ref(props.expand ?? false);
const root = ref<HTMLElement | null>(null);
watch(
    () => props.expand,
    (expand) => {
        if (!expand) return;
        open.value = true;
        requestAnimationFrame(() => root.value?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' }));
    }
);

// ── saved trigger vs. edit draft ────────────────────────────────────────────

const form = useDraftForm(loginTriggerDraftModel, () => props.system, 'system-login');
const { base, draft, conflict, stale, dirty, applyPatch, keepMine } = form;

/**
 * Kept by the page, because a switch moves this card to another section —
 * under a key no command has (ids start at 1), whatever the login's trigger.
 */
const SYSTEM_LOGIN_RESULT_KEY = 0;
const registration = useRegistrationResult(() => SYSTEM_LOGIN_RESULT_KEY);

const errors = ref<FormErrors>(NO_ERRORS);
const saving = ref(false);

const schema = ref<Record<string, unknown> | null>(null);
onMounted(() => {
    getBehaviorSchemas()
        .then((schemas) => (schema.value = schemas.loginTrigger ?? null))
        .catch(() => undefined);
});

const liveErrors = computed<Record<string, string>>(() =>
    dirty.value ? loginTriggerDraftErrors(t, draft.value, schema.value).fields : {}
);
const fieldErrors = computed(() => ({ ...errors.value.fields, ...liveErrors.value }));
const canSave = computed(
    () => dirty.value && !saving.value && !conflict.value && Object.keys(liveErrors.value).length === 0
);

function discard() {
    form.discard();
    errors.value = NO_ERRORS;
}

function showRefusal(err: unknown) {
    if (isStale(err)) {
        form.refusedAsStale();
        errors.value = NO_ERRORS;
        emit('reload');
    } else if (isRegistrationRefusal(err)) {
        errors.value = NO_ERRORS;
        registration.value = registrationFailure(t, err, props.guildNames);
    } else {
        errors.value = errorsFromRefusal(t, err, loginTriggerFields(draft.value));
    }
}

// ── save: board 4's confirm when the kind changes, straight through otherwise ──

const switching = ref(false);
/** A switch that went through, handed to the page once its dialog closes (the card may move). */
let switched: BehaviorItemView | null = null;

async function save() {
    if (!canSave.value) return;
    errors.value = NO_ERRORS;
    if (switchesKind(base.value, draft.value)) {
        registration.value = null;
        switched = null;
        switching.value = true;
        return;
    }
    const patch = loginTriggerPatch(base.value, draft.value);
    if (!patch) return;
    saving.value = true;
    stale.value = false;
    try {
        const found = loginTriggerDraftErrors(t, draft.value, schema.value);
        if (hasErrors(found)) {
            errors.value = found;
            return;
        }
        registration.value = null;
        const result = await switchLoginTrigger(patch);
        form.adopt(result.system);
        if (result.registration) registration.value = registrationResult(t, result.registration, props.guildNames);
        emit('updated', result.system);
    } catch (err) {
        showRefusal(err);
    } finally {
        saving.value = false;
    }
}

function onSwitched(result: { system: BehaviorItemView; registration: RegistrationReport | null }) {
    form.adopt(result.system);
    switched = result.system;
    if (result.registration) registration.value = registrationResult(t, result.registration, props.guildNames);
}

function onSwitchRefused(err: unknown) {
    switching.value = false;
    showRefusal(err);
}

function closeSwitch() {
    switching.value = false;
    if (switched) {
        const system = switched;
        switched = null;
        emit('updated', system);
    }
}

async function resync() {
    if (props.system.kind !== 'command') return;
    registration.value = null;
    try {
        const result = await resyncBehaviorCommand(props.system.id);
        registration.value = registrationResult(t, result.registration, props.guildNames);
        emit('updated', result.command);
    } catch (err) {
        registration.value = registrationFailure(t, err, props.guildNames);
    }
}

// ── view ────────────────────────────────────────────────────────────────────

const leaf = computed(() => (props.system.kind === 'command' ? props.system.leaves[0] : props.system));
const title = computed(() => leaf.value?.title ?? '');
const summary = computed(() => loginTriggerText(loginTriggerDraftOf(props.system)));

const kindOptions = computed<SelectOption<'message' | 'command'>[]>(() => [
    { value: 'message', label: t('behaviors.system.kindMessage') },
    { value: 'command', label: t('behaviors.system.kindCommand') },
]);
const patternKindOptions = computed<SelectOption<LoginPatternKind>[]>(() =>
    LOGIN_PATTERN_KINDS.map((k) => ({ value: k, label: t(`behaviors.trigger.kind.${k}`) }))
);

const visibilityDraft = computed<CommandDraft>(() => loginCommandDraftOf(draft.value));
function patchVisibility(patch: Partial<CommandDraft>) {
    const next: Partial<LoginTriggerDraft> = {};
    if (patch.integrationTypes) next.integrationTypes = patch.integrationTypes;
    if (patch.contexts) next.contexts = patch.contexts;
    applyPatch(next);
}

/** Whether the sample DM would log in — as Discord delivers it, trimmed. */
const preview = computed(() =>
    draft.value.sample.trim() === ''
        ? null
        : previewMatch(draft.value.patternKind, draft.value.patternValue, draft.value.sample.trim())
);

/** Board 3's line under a kind change: the new trigger first, the old one after. */
const switchHint = computed(() => {
    if (!switchesKind(base.value, draft.value)) return '';
    const before = loginTriggerText(loginTriggerDraftOf(base.value));
    const after = loginTriggerText(draft.value);
    return draft.value.kind === 'command'
        ? t('behaviors.system.switchToCommandHint', { command: after, old: before })
        : t('behaviors.system.switchToMessageHint', { pattern: after, old: before });
});
</script>

<template>
    <div ref="root">
        <AppItemCard :expanded="open" accent-bar="neutral" data-test="system-login" @update:expanded="open = $event">
            <template #leading>
                <span class="lead" :title="t('behaviors.card.systemRowLocked')">
                    <Icon icon="material-symbols:lock-outline" width="16" height="16" aria-hidden="true" />
                </span>
            </template>

            <template #title>
                <span class="title">{{ title }}</span>
                <span class="summary" data-test="system-summary">{{ summary }}</span>
            </template>

            <template #trailing>
                <AppBadge v-if="dirty" size="sm" tone="warn" icon="material-symbols:edit-outline-rounded">
                    {{ t('behaviors.card.unsaved') }}
                </AppBadge>
                <AppBadge
                    v-if="system.kind === 'command'"
                    size="sm"
                    tone="accent"
                    variant="outline"
                    icon="material-symbols:bolt-outline-rounded"
                >
                    {{ t('behaviors.card.triggerCommand') }}
                </AppBadge>
                <AppBadge v-else size="sm" icon="material-symbols:article-outline">
                    {{ t('behaviors.card.triggerMessage') }}
                </AppBadge>
                <AppBadge size="sm" icon="material-symbols:settings-outline" :title="t('behaviors.card.tagSystem')">
                    {{ t('behaviors.card.tagSystemShort') }}
                </AppBadge>
                <AppToggle
                    :model-value="true"
                    disabled
                    data-test="enabled-toggle"
                    :title="t('behaviors.card.toggleProtected')"
                    :aria-label="t('behaviors.card.toggleProtected')"
                />
            </template>

            <form class="editor" data-test="login-trigger-form" @submit.prevent="save">
                <Stack gap="3">
                    <BehaviorSourceNotice />
                    <p v-if="!isOwner" class="owner-only" role="note" data-test="owner-only">
                        {{ t('behaviors.system.ownerOnly') }}
                    </p>
                    <CommandRegistrationResult v-if="registration" :result="registration" @dismiss="registration = null" />

                    <AppTextField class="readonly" :model-value="title" :label="t('behaviors.card.titleLabel')" readonly />

                    <fieldset class="trigger" :disabled="!isOwner">
                        <Stack gap="3">
                            <h4 class="part">{{ t('behaviors.trigger.title') }}</h4>
                            <div class="grid">
                                <label class="field">
                                    <span class="field-label">{{ t('behaviors.system.triggerKind') }}</span>
                                    <AppSelectField
                                        :model-value="draft.kind"
                                        :options="kindOptions"
                                        :drawer-title="t('behaviors.system.triggerKind')"
                                        data-test="login-kind"
                                        @update:model-value="applyPatch({ kind: $event })"
                                    />
                                </label>
                            </div>

                            <template v-if="draft.kind === 'message'">
                                <div class="grid">
                                    <label class="field">
                                        <span class="field-label">{{ t('behaviors.trigger.patternKind') }}</span>
                                        <AppSelectField
                                            :model-value="draft.patternKind"
                                            :options="patternKindOptions"
                                            :drawer-title="t('behaviors.trigger.patternKind')"
                                            @update:model-value="applyPatch({ patternKind: $event })"
                                        />
                                        <p v-if="fieldErrors.patternKind" class="field-error">{{ fieldErrors.patternKind }}</p>
                                    </label>
                                    <AppTextField
                                        class="mono"
                                        data-test="login-pattern"
                                        :model-value="draft.patternValue"
                                        :label="t('behaviors.trigger.patternValue')"
                                        :error="fieldErrors.patternValue"
                                        @update:model-value="applyPatch({ patternValue: String($event) })"
                                    />
                                </div>
                                <div class="try">
                                    <AppTextField
                                        data-test="login-sample"
                                        :model-value="draft.sample"
                                        :label="t('behaviors.system.sample')"
                                        :hint="t('behaviors.system.sampleHint')"
                                        :error="fieldErrors.sample"
                                        @update:model-value="applyPatch({ sample: String($event) })"
                                    />
                                    <span v-if="preview && !fieldErrors.sample" role="status" :class="['try-result', preview]">
                                        {{ t(`behaviors.trigger.preview.${preview}`) }}
                                    </span>
                                </div>
                                <p class="hint">{{ t('behaviors.system.messageNote') }}</p>
                            </template>

                            <template v-else>
                                <div class="grid">
                                    <AppTextField
                                        class="mono"
                                        data-test="login-name"
                                        :model-value="draft.name"
                                        :label="t('behaviors.system.commandName')"
                                        :hint="t('behaviors.command.nameHint')"
                                        :error="fieldErrors.name"
                                        @update:model-value="applyPatch({ name: String($event) })"
                                    />
                                    <AppTextField
                                        :model-value="draft.description"
                                        :label="t('behaviors.system.commandDescription')"
                                        :hint="t('behaviors.command.descriptionHint')"
                                        :error="fieldErrors.description"
                                        @update:model-value="applyPatch({ description: String($event) })"
                                    />
                                </div>
                                <CommandVisibilityFields
                                    :draft="visibilityDraft"
                                    :errors="fieldErrors"
                                    :section="system.section"
                                    :guild-names="guildNames"
                                    global-only
                                    :required="LOGIN_COMMAND_REQUIRED"
                                    :required-reason="t('behaviors.system.mustKeep')"
                                    @patch="patchVisibility"
                                />
                                <p class="hint">{{ t('behaviors.system.commandNote') }}</p>
                            </template>
                        </Stack>
                    </fieldset>

                    <BehaviorActionDetails v-if="leaf" :action-source="leaf.actionSource" :webhook="null" :stats="leaf.stats" />

                    <div v-if="conflict" class="conflict" role="alert" data-test="conflict">
                        <span>{{ t('behaviors.card.conflict') }}</span>
                        <AppButton size="sm" variant="secondary" @click="keepMine">{{ t('behaviors.card.conflictKeep') }}</AppButton>
                        <AppButton size="sm" variant="ghost" @click="discard">{{ t('behaviors.card.conflictDiscard') }}</AppButton>
                    </div>
                    <p v-else-if="stale" class="hint" role="status">{{ t('behaviors.card.staleRebased') }}</p>
                    <p v-if="errors.general" class="error" role="alert" data-test="general-error">{{ errors.general }}</p>

                    <footer v-if="isOwner" class="footer">
                        <span v-if="switchHint" class="hint switch-hint" data-test="switch-hint">{{ switchHint }}</span>
                        <AppButton
                            v-if="system.kind === 'command'"
                            variant="ghost"
                            icon="material-symbols:sync-rounded"
                            data-test="resync"
                            :disabled="dirty"
                            @click="resync"
                        >
                            {{ t('behaviors.command.resync') }}
                        </AppButton>
                        <AppButton variant="secondary" :disabled="!dirty || saving" @click="discard">
                            {{ t('common.cancel') }}
                        </AppButton>
                        <AppButton type="submit" data-test="save-login-trigger" :loading="saving" :disabled="!canSave">
                            {{ t('behaviors.system.save') }}
                        </AppButton>
                    </footer>
                </Stack>
            </form>
        </AppItemCard>

        <LoginTriggerSwitchDialog
            :visible="switching"
            :saved="base"
            :draft="draft"
            :guild-names="guildNames"
            @switched="onSwitched"
            @refused="onSwitchRefused"
            @close="closeSwitch"
        />
    </div>
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
.field { display: flex; flex-direction: column; gap: 0.25rem; min-width: 0; }
.field-label { font-size: 0.75rem; color: var(--text-muted); font-weight: 600; }
.field-error { margin: 0; font-size: 0.75rem; color: var(--danger); }
.mono :deep(input) { font-family: var(--font-mono, ui-monospace, monospace); }
.readonly { max-width: 22rem; }
.try {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    padding: 0.55rem 0.7rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg-page);
}
.try-result { font-size: 0.82rem; color: var(--text-muted); }
.try-result.match { color: var(--success-text, var(--text)); }
.try-result.invalid { color: var(--danger); }
.hint { margin: 0; font-size: 0.78rem; color: var(--text-muted); line-height: 1.6; }
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
    flex-wrap: wrap;
    justify-content: flex-end;
    align-items: center;
    gap: 0.5rem;
    padding-top: 0.75rem;
    border-top: 1px solid var(--border);
}
.switch-hint { flex: 1; min-width: 12rem; }
.trigger { border: 0; margin: 0; padding: 0; min-width: 0; }
.owner-only {
    margin: 0;
    padding: 0.5rem 0.7rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    font-size: 0.85rem;
    color: var(--text-muted);
}
</style>

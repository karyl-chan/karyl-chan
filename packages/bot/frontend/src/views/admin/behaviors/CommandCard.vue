<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Icon } from '@iconify/vue';
import {
    AppBadge,
    AppButton,
    AppItemCard,
    AppMenu,
    AppMenuItem,
    AppTextField,
    AppToggle,
    Stack,
} from '@karyl-chan/ui';
import {
    getBehaviorSchemas,
    resyncBehaviorCommand,
    updateBehaviorCommand,
    type CommandLeafView,
    type CommandView,
} from '../../../api/behavior';
import { ApiError } from '../../../api/client';
import BehaviorActionDetails from './BehaviorActionDetails.vue';
import BehaviorSourceNotice from './BehaviorSourceNotice.vue';
import CommandRegistrationResult from './CommandRegistrationResult.vue';
import CommandVisibilityFields from './CommandVisibilityFields.vue';
import { NO_ERRORS, errorsFromRefusal, isStale, type FormErrors } from './behavior-errors';
import { checkCommandDraft, commandDraftErrors, commandFieldsWithErrorLine } from './command-check';
import { commandDraftModel, draftFromCommand, type CommandDraft } from './command-draft';
import { keepEditsOnWith, rebaseDraftWith } from './draft-rebase';
import { hasErrors } from './message-trigger-check';
import { registrationFailure, registrationResult, type RegistrationResult } from './registration-result';
import { useRegistrationResult } from './use-registration-results';
import { trackUnsavedDraft } from './use-unsaved-drafts';

/**
 * A Command (board 5): its name, description and visibility, and its
 * leaves — the root leaf, or one row per subcommand. Every write to it
 * re-registers it on Discord, and the card says what Discord answered
 * (CommandRegistrationResult) — including a refusal, never as success.
 *
 * The saved command (`base`) and the edit draft are kept apart (#105),
 * as for message triggers. The System Behavior's command, if the login
 * ever is one, is read-only here (#106; S7 #139 adds its trigger switch).
 */
const props = defineProps<{
    command: CommandView;
    /** Open the card (and bring it into view) — e.g. right after it moved or was created. */
    expand?: boolean;
    guildNames: ReadonlyMap<string, string>;
}>();

const emit = defineEmits<{
    /** The server's version of the command after a write. */
    (e: 'updated', command: CommandView): void;
    /** The list is out of date (a stale write was refused). */
    (e: 'reload'): void;
}>();

const { t } = useI18n();

const isSystem = computed(
    () => props.command.isSystem || props.command.leaves.some((l) => l.systemKey !== null)
);

const open = ref(props.expand ?? false);
const root = ref<HTMLElement | null>(null);
function bringIntoView() {
    requestAnimationFrame(() => root.value?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' }));
}
watch(
    () => props.expand,
    (expand) => {
        if (!expand) return;
        open.value = true;
        bringIntoView();
    }
);
onMounted(() => {
    if (props.expand) bringIntoView();
});

// ── what the last write did on Discord ──────────────────────────────────────

/** Kept by the page, so the card a moved command reopens in still shows it. */
const registration = useRegistrationResult(() => props.command.id);

function showRegistration(result: RegistrationResult) {
    registration.value = result;
    open.value = true;
}

async function resync() {
    registration.value = null;
    try {
        const result = await resyncBehaviorCommand(props.command.id);
        showRegistration(registrationResult(t, result.registration, props.guildNames));
        emit('updated', result.command);
    } catch (err) {
        showRegistration(registrationFailure(t, err, props.guildNames));
    }
}

// ── saved command vs. edit draft ────────────────────────────────────────────

const base = ref(props.command);
const draft = ref<CommandDraft>(draftFromCommand(props.command));
const conflict = ref(false);
const stale = ref(false);
const dirty = computed(() => commandDraftModel.patchOf(base.value, draft.value) !== null);
trackUnsavedDraft(`command:${props.command.id}`, dirty);

watch(
    () => props.command,
    (incoming) => {
        if (incoming === base.value) return;
        const next = rebaseDraftWith(commandDraftModel, base.value, draft.value, incoming);
        base.value = next.base;
        draft.value = next.draft;
        conflict.value = next.conflict;
    }
);

function applyPatch(patch: Partial<CommandDraft>) {
    draft.value = { ...draft.value, ...patch };
}

function keepMine() {
    stale.value = false;
    draft.value = keepEditsOnWith(commandDraftModel, base.value, draft.value, props.command);
    base.value = props.command;
    conflict.value = false;
}

function discard() {
    stale.value = false;
    base.value = props.command;
    draft.value = draftFromCommand(props.command);
    conflict.value = false;
    errors.value = NO_ERRORS;
}

// ── save ────────────────────────────────────────────────────────────────────

const errors = ref<FormErrors>(NO_ERRORS);
const saving = ref(false);

/** The served command schema, for checking while the admin types; null until loaded. */
const commandSchema = ref<Record<string, unknown> | null>(null);
onMounted(() => {
    if (isSystem.value) return;
    getBehaviorSchemas()
        .then((schemas) => (commandSchema.value = schemas.command ?? null))
        .catch(() => undefined);
});

/**
 * What the server would refuse in the edit, live (board 5): field formats
 * from the served schema, Discord's visibility rules, reserved names — on
 * the field they concern. Only for an edit: the saved command stands.
 */
const liveErrors = computed<Record<string, string>>(() =>
    dirty.value ? commandDraftErrors(t, draft.value, commandSchema.value).fields : {}
);
const fieldErrors = computed(() => ({ ...errors.value.fields, ...liveErrors.value }));

const canSave = computed(
    () => dirty.value && !saving.value && !conflict.value && Object.keys(liveErrors.value).length === 0
);

async function save() {
    const patch = commandDraftModel.patchOf(base.value, draft.value);
    if (!patch || !canSave.value) return;
    saving.value = true;
    stale.value = false;
    try {
        const found = await checkCommandDraft(t, draft.value);
        errors.value = found;
        if (hasErrors(found)) return;
        registration.value = null;
        const result = await updateBehaviorCommand(props.command.id, patch);
        base.value = result.command;
        draft.value = draftFromCommand(result.command);
        showRegistration(registrationResult(t, result.registration, props.guildNames));
        emit('updated', result.command);
    } catch (err) {
        if (isStale(err)) {
            conflict.value = true;
            stale.value = true;
            errors.value = NO_ERRORS;
            emit('reload');
        } else if (err instanceof ApiError && err.code === 'registration_failed') {
            // nothing was saved: the edit stays in the draft, Discord's answer above it
            errors.value = NO_ERRORS;
            showRegistration(registrationFailure(t, err, props.guildNames));
        } else {
            errors.value = errorsFromRefusal(t, err, commandFieldsWithErrorLine(draft.value));
        }
    } finally {
        saving.value = false;
    }
}

// ── view ────────────────────────────────────────────────────────────────────

const anyEnabled = computed(() => props.command.leaves.some((l) => l.enabled));
const isRoot = computed(
    () => props.command.leaves.length === 1 && props.command.leaves[0].subcommand === ''
);
const unhealthy = computed(() =>
    props.command.leaves.some((l) => (l.stats?.consecutiveFailures ?? 0) >= 3)
);

function leafPath(leaf: CommandLeafView): string {
    return [props.command.name, leaf.subcommandGroup, leaf.subcommand].filter(Boolean).join(' ');
}

const registrationTarget = computed(() =>
    props.command.registration === 'guild'
        ? t('behaviors.card.registrationGuild', {
              guild: props.guildNames.get(props.command.guildId ?? '') ?? props.command.guildId,
          })
        : t('behaviors.card.registrationGlobal')
);
</script>

<template>
    <div ref="root">
        <AppItemCard
            :expanded="open"
            :disabled="!anyEnabled"
            :accent-bar="isSystem ? 'neutral' : 'accent'"
            @update:expanded="open = $event"
        >
            <template #leading>
                <span class="lead" :title="isSystem ? t('behaviors.card.systemRowLocked') : undefined" aria-hidden="true">
                    <Icon
                        :icon="isSystem ? 'material-symbols:lock-outline' : 'material-symbols:bolt-outline-rounded'"
                        width="16" height="16"
                    />
                </span>
            </template>

            <template #title>
                <span class="title">/{{ command.name }}</span>
                <span class="summary">{{ command.description }}</span>
            </template>

            <template #trailing>
                <AppBadge v-if="dirty" size="sm" tone="warn" icon="material-symbols:edit-outline-rounded">
                    {{ t('behaviors.card.unsaved') }}
                </AppBadge>
                <AppBadge size="sm" tone="accent" variant="outline" icon="material-symbols:bolt-outline-rounded">
                    {{ t('behaviors.card.triggerCommand') }}
                </AppBadge>
                <AppBadge v-if="!isRoot" size="sm">
                    {{ t('behaviors.card.subcommandCount', { count: command.leaves.length }) }}
                </AppBadge>
                <AppBadge v-if="isSystem" size="sm" icon="material-symbols:settings-outline" :title="t('behaviors.card.tagSystem')">
                    {{ t('behaviors.card.tagSystemShort') }}
                </AppBadge>
                <AppBadge v-if="unhealthy" size="sm" tone="danger" icon="material-symbols:heart-broken-rounded">
                    {{ t('behaviors.card.unhealthy') }}
                </AppBadge>
                <AppToggle
                    v-if="isRoot"
                    :model-value="command.leaves[0].enabled"
                    disabled
                    data-test="enabled-toggle"
                    :title="isSystem ? t('behaviors.card.toggleProtected') : t('behaviors.card.toggleReadOnly')"
                    :aria-label="command.leaves[0].enabled ? t('behaviors.card.enabled') : t('behaviors.card.disabled')"
                />
                <AppMenu v-if="!isSystem" placement="bottom-end" :offset="[0, 6]">
                    <template #trigger>
                        <button type="button" class="more-btn" :aria-label="t('behaviors.card.more')" :title="t('behaviors.card.more')">
                            <Icon icon="material-symbols:more-vert" width="16" height="16" />
                        </button>
                    </template>
                    <AppMenuItem data-test="resync" @click="resync">
                        <Icon icon="material-symbols:sync-rounded" width="16" height="16" />
                        {{ t('behaviors.command.resync') }}
                    </AppMenuItem>
                </AppMenu>
            </template>

            <Stack gap="3">
                <CommandRegistrationResult v-if="registration" :result="registration" @dismiss="registration = null" />

                <template v-if="isSystem">
                    <BehaviorSourceNotice />
                    <dl class="details">
                        <dt>{{ t('behaviors.command.registration.label') }}</dt>
                        <dd>{{ registrationTarget }}</dd>
                        <dt>{{ t('behaviors.card.contexts') }}</dt>
                        <dd>{{ command.contexts.map((c) => t(`behaviors.card.context.${c}`)).join('、') }}</dd>
                        <dt>{{ t('behaviors.card.integrationTypes') }}</dt>
                        <dd>{{ command.integrationTypes.map((i) => t(`behaviors.card.integration.${i}`)).join('、') }}</dd>
                        <dt>{{ t('behaviors.card.defaultMemberPermissions') }}</dt>
                        <dd>{{ command.defaultMemberPermissions ?? t('behaviors.card.permissionsNone') }}</dd>
                    </dl>
                </template>

                <form v-else class="editor" data-test="command-form" @submit.prevent="save">
                    <Stack gap="3">
                        <div class="grid">
                            <AppTextField
                                class="mono"
                                :model-value="draft.name"
                                :label="t('behaviors.command.name')"
                                :hint="t('behaviors.command.nameHint')"
                                :error="fieldErrors.name"
                                @update:model-value="applyPatch({ name: String($event) })"
                            />
                            <AppTextField
                                :model-value="draft.description"
                                :label="t('behaviors.command.description')"
                                :hint="t('behaviors.command.descriptionHint')"
                                :error="fieldErrors.description"
                                @update:model-value="applyPatch({ description: String($event) })"
                            />
                        </div>

                        <CommandVisibilityFields
                            :draft="draft"
                            :errors="fieldErrors"
                            :section="command.section"
                            :guild-names="guildNames"
                            @patch="applyPatch"
                        />

                        <div v-if="conflict" class="conflict" role="alert" data-test="conflict">
                            <span>{{ t('behaviors.card.conflict') }}</span>
                            <AppButton size="sm" variant="secondary" data-test="keep-mine" @click="keepMine">
                                {{ t('behaviors.card.conflictKeep') }}
                            </AppButton>
                            <AppButton size="sm" variant="ghost" @click="discard">
                                {{ t('behaviors.card.conflictDiscard') }}
                            </AppButton>
                        </div>
                        <p v-else-if="stale" class="hint" role="status">{{ t('behaviors.card.staleRebased') }}</p>
                        <p v-if="errors.general" class="error" role="alert" data-test="general-error">{{ errors.general }}</p>

                        <footer class="footer">
                            <AppButton variant="secondary" :disabled="!dirty || saving" @click="discard">
                                {{ t('common.cancel') }}
                            </AppButton>
                            <AppButton type="submit" data-test="save-command" :loading="saving" :disabled="!canSave">
                                {{ t('behaviors.command.saveAndSync') }}
                            </AppButton>
                        </footer>
                    </Stack>
                </form>

                <ul class="leaves">
                    <li v-for="leaf in command.leaves" :key="leaf.id" class="leaf">
                        <header class="leaf-head">
                            <code class="leaf-path">/{{ leafPath(leaf) }}</code>
                            <span class="leaf-title">{{ leaf.title }}</span>
                        </header>
                        <p v-if="leaf.leafDescription && !isRoot" class="leaf-desc">{{ leaf.leafDescription }}</p>
                        <p v-if="leaf.options.length > 0" class="options">
                            {{ t('behaviors.card.options') }}:
                            <code v-for="o in leaf.options" :key="o.name" class="option">
                                {{ o.name }}{{ o.required ? '' : '?' }}: {{ o.type }}
                            </code>
                        </p>
                        <BehaviorActionDetails
                            :action-source="leaf.actionSource"
                            :webhook="leaf.webhook"
                            :stats="leaf.stats"
                        />
                    </li>
                </ul>
            </Stack>
        </AppItemCard>
    </div>
</template>

<style scoped>
.lead {
    color: var(--text-muted);
    display: inline-flex;
    align-items: center;
    padding: 0.25rem;
}
.title {
    font-weight: 600;
    color: var(--text-strong);
    white-space: nowrap;
    flex-shrink: 0;
}
.summary {
    color: var(--text-muted);
    font-size: 0.8rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
}
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
}
.more-btn:hover { background: var(--bg-surface-hover, var(--bg-page)); color: var(--text); }
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
dd { margin: 0; overflow-wrap: anywhere; }
.hint { margin: 0; font-size: 0.78rem; color: var(--text-muted); }
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
.leaves {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
}
.leaf {
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 0.5rem 0.65rem;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
}
.leaf-head { display: flex; align-items: center; gap: 0.5rem; }
.leaf-path { font-weight: 600; }
.leaf-title { color: var(--text-muted); font-size: 0.85rem; }
.leaf-desc { margin: 0; font-size: 0.85rem; }
.options { margin: 0; font-size: 0.82rem; color: var(--text-muted); display: flex; flex-wrap: wrap; gap: 0.35rem; }
.option { color: var(--text); }
</style>

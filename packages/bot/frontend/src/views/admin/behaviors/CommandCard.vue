<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';
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
    useConfirm,
    useToastStore,
} from '@karyl-chan/ui';
import {
    deleteBehaviorCommand,
    getBehaviorSchemas,
    resyncBehaviorCommand,
    updateBehavior,
    updateBehaviorCommand,
    type CommandView,
    type RegistrationReport,
} from '../../../api/behavior';
import CommandRegistrationResult from './CommandRegistrationResult.vue';
import CommandVisibilityFields from './CommandVisibilityFields.vue';
import ConvertToSubcommandDialog from './ConvertToSubcommandDialog.vue';
import SubcommandList from './SubcommandList.vue';
import { NO_ERRORS, errorsFromRefusal, hasErrors, isStale, type FormErrors } from './behavior-errors';
import { checkCommandDraft, commandDraftErrors, commandFieldsWithErrorLine } from './command-check';
import { commandDraftModel } from './command-draft';
import {
    isRegistrationRefusal,
    registrationFailure,
    registrationResult,
    type RegistrationResult,
} from './registration-result';
import { useDraftForm } from './use-draft-form';
import { useRegistrationResult } from './use-registration-results';

/**
 * A Command (board 5): its name, description and visibility, and its
 * leaves — the root leaf, or one row per subcommand. Every write to it
 * re-registers it on Discord, and the card says what Discord answered
 * (CommandRegistrationResult) — including a refusal, never as success.
 *
 * The saved command (`base`) and the edit draft are kept apart (#105),
 * as for message triggers. The System Behavior's command is not shown
 * here: SystemLoginCard owns the login, whatever its trigger.
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
    /** The list is out of date (a stale write was refused, a leaf was removed). */
    (e: 'reload'): void;
    (e: 'deleted', id: number): void;
}>();

const { t } = useI18n();
const { confirm } = useConfirm();
const toast = useToastStore();

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

/** A leaf write went through: the command as it now is, and what Discord did. */
function onLeafWrote(result: { command: CommandView; registration?: RegistrationReport }) {
    if (result.registration) showRegistration(registrationResult(t, result.registration, props.guildNames));
    emit('updated', result.command);
}

function onRefused(err: unknown) {
    showRegistration(registrationFailure(t, err, props.guildNames));
}

// ── board 6: a single command gains subcommands ─────────────────────────────

const converting = ref(false);
const leafList = ref<InstanceType<typeof SubcommandList> | null>(null);

async function onConverted(result: { command: CommandView; registration: RegistrationReport }) {
    converting.value = false;
    onLeafWrote(result);
    // "convert and add a subcommand": straight on to the new one
    await nextTick();
    leafList.value?.openAdd();
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

const form = useDraftForm(commandDraftModel, () => props.command, `command:${props.command.id}`);
const { base, draft, conflict, stale, dirty, applyPatch, keepMine } = form;

function discard() {
    form.discard();
    errors.value = NO_ERRORS;
}

// ── save ────────────────────────────────────────────────────────────────────

const errors = ref<FormErrors>(NO_ERRORS);
const saving = ref(false);

/** The served command schema, for checking while the admin types; null until loaded. */
const commandSchema = ref<Record<string, unknown> | null>(null);
onMounted(() => {
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
    const patch = form.pendingPatch();
    if (!patch || !canSave.value) return;
    saving.value = true;
    stale.value = false;
    try {
        const found = await checkCommandDraft(t, draft.value);
        errors.value = found;
        if (hasErrors(found)) return;
        registration.value = null;
        const result = await updateBehaviorCommand(props.command.id, patch);
        form.adopt(result.command);
        showRegistration(registrationResult(t, result.registration, props.guildNames));
        emit('updated', result.command);
    } catch (err) {
        if (isStale(err)) {
            form.refusedAsStale();
            errors.value = NO_ERRORS;
            emit('reload');
        } else if (isRegistrationRefusal(err)) {
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

// ── header actions ──────────────────────────────────────────────────────────

const toggling = ref(false);
/** The root leaf's switch is the command's (a single command has no other). */
async function setRootEnabled(enabled: boolean) {
    toggling.value = true;
    try {
        // not tied to a version: switching on / off is meant to win
        const result = await updateBehavior(props.command.leaves[0].id, { enabled });
        if (result.command) onLeafWrote({ command: result.command, registration: result.registration });
    } catch (err) {
        onRefused(err);
    } finally {
        toggling.value = false;
    }
}

async function confirmDelete() {
    const ok = await confirm({
        title: t('behaviors.command.deleteTitle'),
        message: t('behaviors.command.deleteMessage', { command: props.command.name }),
        confirmLabel: t('behaviors.command.delete'),
        confirmVariant: 'danger',
        cancelLabel: t('common.cancel'),
    });
    if (ok) await removeCommand();
}

async function removeCommand() {
    try {
        const result = await deleteBehaviorCommand(props.command.id);
        const outcome = registrationResult(t, result.registration, props.guildNames);
        toast.show(
            [t('behaviors.command.deleted', { command: props.command.name }), outcome.detail].filter(Boolean).join(' '),
            outcome.tone === 'ok' ? 'success' : 'warn'
        );
        emit('deleted', props.command.id);
    } catch (err) {
        onRefused(err);
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
</script>

<template>
    <div ref="root">
        <AppItemCard
            :expanded="open"
            :disabled="!anyEnabled"
            accent-bar="accent"
            @update:expanded="open = $event"
        >
            <template #leading>
                <span class="lead" aria-hidden="true">
                    <Icon icon="material-symbols:bolt-outline-rounded" width="16" height="16" />
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
                <AppBadge v-if="unhealthy" size="sm" tone="danger" icon="material-symbols:heart-broken-rounded">
                    {{ t('behaviors.card.unhealthy') }}
                </AppBadge>
                <AppToggle
                    v-if="isRoot"
                    :model-value="command.leaves[0].enabled"
                    :disabled="toggling"
                    data-test="enabled-toggle"
                    :aria-label="command.leaves[0].enabled ? t('behaviors.card.enabled') : t('behaviors.card.disabled')"
                    @update:model-value="setRootEnabled"
                />
                <AppMenu placement="bottom-end" :offset="[0, 6]">
                    <template #trigger>
                        <button type="button" class="more-btn" :aria-label="t('behaviors.card.more')" :title="t('behaviors.card.more')">
                            <Icon icon="material-symbols:more-vert" width="16" height="16" />
                        </button>
                    </template>
                    <AppMenuItem data-test="resync" @click="resync">
                        <Icon icon="material-symbols:sync-rounded" width="16" height="16" />
                        {{ t('behaviors.command.resync') }}
                    </AppMenuItem>
                    <AppMenuItem danger data-test="delete-command" @click="confirmDelete">
                        <Icon icon="material-symbols:delete-outline-rounded" width="16" height="16" />
                        {{ t('behaviors.command.delete') }}
                    </AppMenuItem>
                </AppMenu>
            </template>

            <Stack gap="3">
                <CommandRegistrationResult v-if="registration" :result="registration" @dismiss="registration = null" />

                <form class="editor" data-test="command-form" @submit.prevent="save">
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

                <SubcommandList
                    ref="leafList"
                    :command="command"
                    @wrote="onLeafWrote"
                    @refused="onRefused"
                    @removed="showRegistration(registrationResult(t, $event, guildNames))"
                    @reload="emit('reload')"
                    @delete-command="removeCommand"
                    @convert="converting = true"
                />
                <ConvertToSubcommandDialog
                    v-if="isRoot"
                    :visible="converting"
                    :command="command"
                    :guild-names="guildNames"
                    @close="converting = false"
                    @converted="onConverted"
                />

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
</style>

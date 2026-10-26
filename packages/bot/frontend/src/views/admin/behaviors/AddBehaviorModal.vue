<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Icon } from '@iconify/vue';
import { AppButton, AppModal, AppTextField, Stack } from '@karyl-chan/ui';
import {
    createBehaviorCommand,
    createMessageTrigger,
    type BehaviorSection,
    type CommandView,
    type MessageTriggerView,
} from '../../../api/behavior';
import { ApiError } from '../../../api/client';
import CommandRegistrationResult from './CommandRegistrationResult.vue';
import MessageTriggerFields from './MessageTriggerFields.vue';
import OneTimeSecret from './OneTimeSecret.vue';
import WebhookActionFields from './WebhookActionFields.vue';
import { NO_ERRORS, errorsFromRefusal, onFields, type FormErrors } from './behavior-errors';
import { checkCommandDraft } from './command-check';
import { commandBody, newCommandVisibility, type CommandDraft } from './command-draft';
import { checkLeafDraft } from './leaf-check';
import { emptyLeafDraft } from './leaf-draft';
import {
    checkMessageTriggerDraft,
    fieldsWithErrorLine,
    hasErrors,
    type TriggerFormLayout,
} from './message-trigger-check';
import { draftPatcher, emptyDraft, toCreateBody, type MessageTriggerDraft } from './message-trigger-draft';
import { newBehaviorOptions } from './new-behavior-options';
import { registrationFailure, registrationResult, type RegistrationResult } from './registration-result';
import { sectionLabel } from './section-labels';
import { webhookBody } from './webhook-draft';

/**
 * "New behavior" in a section (board 2): only what the section can hold is
 * offered, and a disabled choice says why.
 *
 * A message trigger is created where the section is. A command is created
 * as a single command (its root leaf) with the visibility that keeps it in
 * the section (newCommandVisibility); the card changes it afterwards. The
 * name is checked against the namespace on the server (`name_conflict`
 * lands on the name field) and `login` is refused before sending.
 *
 * After a create the dialog shows the secret the bot generated, once —
 * for a command also what Discord answered — before closing.
 */
const props = defineProps<{
    visible: boolean;
    section: BehaviorSection;
    guildNames: ReadonlyMap<string, string>;
    /** Audience Groups some trigger already uses. */
    groupNames?: readonly string[];
}>();

const emit = defineEmits<{
    (e: 'close'): void;
    (e: 'created', item: MessageTriggerView | CommandView): void;
    /** The list may have changed without a `created` (a refused create whose undo failed). */
    (e: 'reload'): void;
}>();

const { t } = useI18n();

type Kind = 'command' | 'message';

const options = computed(() => newBehaviorOptions(props.section));
const choices = computed(() => ({ command: options.value.command, message: options.value.message }));

const kind = ref<Kind | null>(null);
/** The message trigger draft; its title and webhook are a new command's too. */
const draft = ref<MessageTriggerDraft>(emptyDraft({ kind: 'bot_dm' }));
const applyPatch = draftPatcher(draft);
const command = ref({ name: '', description: '' });
const errors = ref<FormErrors>(NO_ERRORS);
const creating = ref(false);
/** A command Discord refused: nothing was created. */
const refused = ref<RegistrationResult | null>(null);

interface Created {
    title: string;
    registration: RegistrationResult | null;
    secrets: Array<{ label: string; secret: string }>;
}
const created = ref<Created | null>(null);

function reset() {
    const message = options.value.message;
    kind.value = (['message', 'command'] as const).find((k) => choices.value[k].possible) ?? null;
    draft.value = emptyDraft({
        kind: message.locations[0] ?? 'bot_dm',
        guildId: message.guildId,
        channelId: message.channelId,
    });
    command.value = { name: '', description: '' };
    errors.value = NO_ERRORS;
    refused.value = null;
    created.value = null;
}

// Start fresh each time the dialog opens — only then: after a create the
// page follows the new item to its section while the one-time secret
// is still on screen, and that must not wipe it.
watch(
    () => props.visible,
    (visible) => {
        if (visible) reset();
    },
    { immediate: true }
);

watch(kind, () => {
    errors.value = NO_ERRORS;
    refused.value = null;
});

/** What the dialog shows: the section fixes what it fixes; no description field. */
const layout = computed<TriggerFormLayout>(() => ({
    kinds: options.value.message.locations,
    lockGuild: options.value.message.lockGuild,
    lockChannel: options.value.message.lockChannel,
    description: false,
}));

const denied = computed(() =>
    (['command', 'message'] as const)
        .map((k) => choices.value[k].reason)
        .filter((r): r is string => r !== null)
        .map((r) => t(r))
);

// ── a new command ───────────────────────────────────────────────────────────

const preset = computed(() => newCommandVisibility(props.section));

/** The visibility the section gives a new command, in words (board 2). */
const presetSummary = computed(() => {
    const p = preset.value;
    if (!p) return '';
    return [
        p.registration === 'guild'
            ? t('behaviors.card.registrationGuild', { guild: props.guildNames.get(p.guildId) ?? p.guildId })
            : t('behaviors.command.registration.global'),
        p.integrationTypes.map((i) => t(`behaviors.card.integration.${i}`)).join('＋'),
        p.contexts.map((c) => t(`behaviors.card.context.${c}`)).join('、'),
    ].join(' · ');
});

/** The fields the command form shows an error line on. */
const COMMAND_FIELDS = ['title', 'name', 'description', 'webhook.url', 'webhook.authMode'];

/** `leaves.0.title` → `title`: the dialog's one leaf is its own fields. */
const leafField = (field: string) => field.replace(/^leaves\.0\./, '');

function commandDraft(): CommandDraft {
    return { ...preset.value!, ...command.value, defaultMemberPermissions: '' };
}

async function createCommand() {
    const cmd = commandDraft();
    const leaf = { ...emptyLeafDraft(), title: draft.value.title, webhookUrl: draft.value.webhookUrl, authMode: draft.value.authMode };
    const [commandErrors, leafErrors] = await Promise.all([checkCommandDraft(t, cmd), checkLeafDraft(t, leaf, 'root')]);
    const found = onFields(
        {
            fields: { ...leafErrors.fields, ...commandErrors.fields },
            general: commandErrors.general ?? leafErrors.general,
        },
        COMMAND_FIELDS
    );
    errors.value = found;
    if (hasErrors(found)) return;

    try {
        const result = await createBehaviorCommand({
            ...commandBody(cmd),
            leaves: [{ subcommand: '', title: leaf.title.trim(), webhook: webhookBody(leaf) }],
        });
        emit('created', result.command);
        created.value = {
            title: leaf.title.trim(),
            registration: registrationResult(t, result.registration, props.guildNames),
            secrets: (result.secrets ?? []).map((s) => ({
                label: ['/' + result.command.name, s.subcommand].filter(Boolean).join(' '),
                secret: s.secret,
            })),
        };
    } catch (err) {
        if (err instanceof ApiError && err.code === 'registration_failed') {
            refused.value = registrationFailure(t, err, props.guildNames);
            // Discord refused and the rows are normally taken back — unless
            // that undo failed ("the change is still stored"): reload so the
            // list shows what the server holds either way
            emit('reload');
        } else {
            errors.value = errorsFromRefusal(t, err, COMMAND_FIELDS, leafField);
        }
    }
}

// ── a new message trigger ───────────────────────────────────────────────────

async function createTrigger() {
    const found = await checkMessageTriggerDraft(t, draft.value, layout.value);
    errors.value = found;
    if (hasErrors(found)) return;
    try {
        const body = toCreateBody(draft.value);
        const result = await createMessageTrigger(body);
        emit('created', result.behavior);
        if (result.secret) {
            created.value = { title: body.title, registration: null, secrets: [{ label: '', secret: result.secret }] };
        } else emit('close');
    } catch (err) {
        errors.value = errorsFromRefusal(t, err, fieldsWithErrorLine(draft.value, layout.value));
    }
}

async function create() {
    if (kind.value === null || creating.value) return;
    creating.value = true;
    refused.value = null;
    try {
        if (kind.value === 'command') await createCommand();
        else await createTrigger();
    } finally {
        creating.value = false;
    }
}
</script>

<template>
    <AppModal
        :visible="visible"
        :title="t('behaviors.add.title')"
        :close-label="t('common.close')"
        width="min(560px, 95vw)"
        @close="emit('close')"
    >
        <Stack v-if="created" gap="3">
            <p class="intro">{{ t('behaviors.add.created', { title: created.title }) }}</p>
            <CommandRegistrationResult v-if="created.registration" :result="created.registration" @dismiss="created.registration = null" />
            <Stack v-for="s in created.secrets" :key="s.label" gap="1">
                <code v-if="s.label" class="secret-for">{{ s.label }}</code>
                <OneTimeSecret :secret="s.secret" @dismiss="created.secrets = created.secrets.filter((x) => x !== s)" />
            </Stack>
            <footer class="footer">
                <AppButton data-test="done" @click="emit('close')">{{ t('behaviors.add.done') }}</AppButton>
            </footer>
        </Stack>

        <form v-else @submit.prevent="create">
            <Stack gap="3">
                <p class="intro">{{ t('behaviors.add.intro', { section: sectionLabel(t, section, guildNames) }) }}</p>

                <AppTextField
                    v-model="draft.title"
                    :label="t('behaviors.add.name')"
                    :placeholder="t('behaviors.add.namePlaceholder')"
                    :error="errors.fields.title"
                    autofocus
                />

                <Stack gap="1">
                    <span class="field-label" id="nb-kind">{{ t('behaviors.add.kind') }}</span>
                    <div class="kind-grid" role="radiogroup" aria-labelledby="nb-kind">
                        <button
                            v-for="k in (['command', 'message'] as const)"
                            :key="k"
                            type="button"
                            role="radio"
                            :data-test="`kind-${k}`"
                            :class="['kind', { on: kind === k }]"
                            :aria-checked="kind === k ? 'true' : 'false'"
                            :disabled="!choices[k].possible"
                            @click="kind = k"
                        >
                            <Icon
                                :icon="k === 'command' ? 'material-symbols:bolt-outline-rounded' : 'material-symbols:article-outline'"
                                width="16"
                                height="16"
                                aria-hidden="true"
                            />
                            {{ t(`behaviors.add.kinds.${k}`) }}
                        </button>
                    </div>
                    <p v-for="reason in denied" :key="reason" class="denied" data-test="denied">{{ reason }}</p>
                </Stack>

                <template v-if="kind === 'command'">
                    <AppTextField
                        v-model="command.name"
                        class="mono"
                        :label="t('behaviors.command.name')"
                        :placeholder="t('behaviors.add.commandNamePlaceholder')"
                        :hint="t('behaviors.command.nameHint')"
                        :error="errors.fields.name"
                    />
                    <AppTextField
                        v-model="command.description"
                        :label="t('behaviors.command.description')"
                        :hint="t('behaviors.command.descriptionHint')"
                        :error="errors.fields.description"
                    />
                    <div class="preset" data-test="command-preset">
                        <span class="field-label">{{ t('behaviors.add.commandPreset') }}</span>
                        <span class="preset-value">{{ presetSummary }}</span>
                    </div>
                </template>

                <MessageTriggerFields
                    v-if="kind === 'message'"
                    :draft="draft"
                    :kinds="layout.kinds"
                    :lock-guild="layout.lockGuild"
                    :lock-channel="layout.lockChannel"
                    :errors="errors.fields"
                    :group-names="groupNames ?? []"
                    @patch="applyPatch"
                />
                <WebhookActionFields
                    v-if="kind !== null"
                    :draft="draft"
                    :errors="errors.fields"
                    :saved="null"
                    :behavior-id="null"
                    :issued-secret="null"
                    @patch="applyPatch"
                />

                <CommandRegistrationResult v-if="refused" :result="refused" @dismiss="refused = null" />
                <p v-if="errors.general" class="error" role="alert">{{ errors.general }}</p>

                <footer class="footer">
                    <AppButton variant="secondary" @click="emit('close')">{{ t('common.cancel') }}</AppButton>
                    <AppButton
                        type="submit"
                        data-test="create"
                        :loading="creating"
                        :disabled="kind === null || creating"
                    >
                        {{ t('behaviors.add.create') }}
                    </AppButton>
                </footer>
            </Stack>
        </form>
    </AppModal>
</template>

<style scoped>
.intro { margin: 0; color: var(--text); font-size: 0.9rem; }
.field-label { font-size: 0.75rem; color: var(--text-muted); font-weight: 600; }
.kind-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 0.4rem;
}
.kind {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 0.35rem;
    min-height: 2.25rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg-page);
    color: var(--text);
    font: inherit;
    font-size: 0.86rem;
    cursor: pointer;
}
.kind.on {
    border-color: var(--accent);
    background: var(--accent);
    color: var(--accent-contrast, #fff);
}
.kind:disabled {
    cursor: not-allowed;
    border-style: dashed;
    background: transparent;
    color: var(--text-muted);
}
.denied { margin: 0; font-size: 0.78rem; line-height: 1.5; color: var(--text-muted); }
.mono :deep(input) { font-family: var(--font-mono, ui-monospace, monospace); }
.preset {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    padding: 0.5rem 0.65rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg-page);
}
.preset-value { font-size: 0.85rem; color: var(--text-strong); }
.secret-for { font-size: 0.8rem; color: var(--text-muted); }
.error { margin: 0; font-size: 0.82rem; color: var(--danger); }
.footer { display: flex; justify-content: flex-end; gap: 0.5rem; }
</style>

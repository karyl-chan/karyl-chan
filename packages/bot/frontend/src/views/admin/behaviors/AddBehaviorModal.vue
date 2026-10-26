<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Icon } from '@iconify/vue';
import { AppButton, AppModal, AppTextField, Stack } from '@karyl-chan/ui';
import {
    createMessageTrigger,
    type BehaviorSection,
    type MessageTriggerView,
} from '../../../api/behavior';
import MessageTriggerFields from './MessageTriggerFields.vue';
import OneTimeSecret from './OneTimeSecret.vue';
import WebhookActionFields from './WebhookActionFields.vue';
import { NO_ERRORS, errorsFromRefusal, type FormErrors } from './behavior-errors';
import {
    checkMessageTriggerDraft,
    fieldsWithErrorLine,
    hasErrors,
    type TriggerFormLayout,
} from './message-trigger-check';
import { draftPatcher, emptyDraft, toCreateBody, type MessageTriggerDraft } from './message-trigger-draft';
import { newBehaviorOptions, type KindOption } from './new-behavior-options';
import { sectionLabel } from './section-labels';

/**
 * "New behavior" in a section (board 2): only what the section can hold is
 * offered, and a disabled choice says why. Creating a message trigger
 * shows the secret the bot generated, once, before closing.
 *
 * Commands are created from here once S6 (#138) adds their form; until
 * then the command choice is disabled with that reason.
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
    (e: 'created', trigger: MessageTriggerView): void;
}>();

const { t } = useI18n();

/** The command form arrives with S6 (#138). */
const COMMAND_FORM_READY = false;

type Kind = 'command' | 'message';

const options = computed(() => newBehaviorOptions(props.section));
const choices = computed<Record<Kind, KindOption>>(() => ({
    command:
        options.value.command.possible && !COMMAND_FORM_READY
            ? { possible: false, reason: 'behaviors.add.reason.commandLater' }
            : options.value.command,
    message: options.value.message,
}));

const kind = ref<Kind | null>(null);
const draft = ref<MessageTriggerDraft>(emptyDraft({ kind: 'bot_dm' }));
const applyPatch = draftPatcher(draft);
const errors = ref<FormErrors>(NO_ERRORS);
const creating = ref(false);
const issued = ref<{ title: string; secret: string } | null>(null);

function reset() {
    const message = options.value.message;
    kind.value = (['message', 'command'] as const).find((k) => choices.value[k].possible) ?? null;
    draft.value = emptyDraft({
        kind: message.locations[0] ?? 'bot_dm',
        guildId: message.guildId,
        channelId: message.channelId,
    });
    errors.value = NO_ERRORS;
    issued.value = null;
}

// Start fresh each time the dialog opens — only then: after a create the
// page follows the new trigger to its section while the one-time secret
// is still on screen, and that must not wipe it.
watch(
    () => props.visible,
    (visible) => {
        if (visible) reset();
    },
    { immediate: true }
);

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

async function create() {
    if (kind.value !== 'message' || creating.value) return;
    creating.value = true;
    try {
        const found = await checkMessageTriggerDraft(t, draft.value, layout.value);
        errors.value = found;
        if (hasErrors(found)) return;

        const body = toCreateBody(draft.value);
        const result = await createMessageTrigger(body);
        emit('created', result.behavior);
        if (result.secret) issued.value = { title: body.title, secret: result.secret };
        else emit('close');
    } catch (err) {
        errors.value = errorsFromRefusal(t, err, fieldsWithErrorLine(draft.value, layout.value));
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
        <Stack v-if="issued" gap="3">
            <p class="intro">{{ t('behaviors.add.created', { title: issued.title }) }}</p>
            <OneTimeSecret :secret="issued.secret" @dismiss="emit('close')" />
            <footer class="footer">
                <AppButton data-test="done" @click="emit('close')">{{ t('behaviors.add.done') }}</AppButton>
            </footer>
        </Stack>

        <form v-else class="form" @submit.prevent="create">
            <p class="intro">{{ t('behaviors.add.intro', { section: sectionLabel(t, section, guildNames) }) }}</p>

            <AppTextField
                v-model="draft.title"
                :label="t('behaviors.add.name')"
                :placeholder="t('behaviors.add.namePlaceholder')"
                :error="errors.fields.title"
                autofocus
            />

            <div class="kinds">
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
            </div>

            <template v-if="kind === 'message'">
                <MessageTriggerFields
                    :draft="draft"
                    :kinds="layout.kinds"
                    :lock-guild="layout.lockGuild"
                    :lock-channel="layout.lockChannel"
                    :errors="errors.fields"
                    :group-names="groupNames ?? []"
                    @patch="applyPatch"
                />
                <WebhookActionFields
                    :draft="draft"
                    :errors="errors.fields"
                    :saved="null"
                    :behavior-id="null"
                    :issued-secret="null"
                    @patch="applyPatch"
                />
            </template>

            <p v-if="errors.general" class="error" role="alert">{{ errors.general }}</p>

            <footer class="footer">
                <AppButton variant="secondary" @click="emit('close')">{{ t('common.cancel') }}</AppButton>
                <AppButton
                    type="submit"
                    data-test="create"
                    :loading="creating"
                    :disabled="kind !== 'message' || creating"
                >
                    {{ t('behaviors.add.create') }}
                </AppButton>
            </footer>
        </form>
    </AppModal>
</template>

<style scoped>
.form { display: flex; flex-direction: column; gap: 0.8rem; }
.intro { margin: 0; color: var(--text); font-size: 0.9rem; }
.kinds { display: flex; flex-direction: column; gap: 0.35rem; }
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
.error { margin: 0; font-size: 0.82rem; color: var(--danger); }
.footer { display: flex; justify-content: flex-end; gap: 0.5rem; }
</style>

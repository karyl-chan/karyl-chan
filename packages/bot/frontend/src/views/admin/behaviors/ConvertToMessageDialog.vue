<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { AppButton, AppModal, AppSelectField, Stack, useToastStore, type SelectOption } from '@karyl-chan/ui';
import {
    convertToMessage,
    getBehaviorSchemas,
    type CommandView,
    type MessageTriggerView,
} from '../../../api/behavior';
import ConvertLosses from './ConvertLosses.vue';
import MessageTriggerFields from './MessageTriggerFields.vue';
import { NO_ERRORS, errorsFromIssues, errorsFromRefusal, isStale, type FormErrors } from './behavior-errors';
import { commandPath } from './command-draft';
import {
    CONVERT_LOCATION_KINDS,
    convertedMessageDraft,
    toMessageBody,
    toMessageLosses,
} from './convert-trigger-draft';
import { checkAgainstSchema } from './form-schema';
import { fieldsWithErrorLine, type TriggerFormLayout } from './message-trigger-check';
import { previewMatch, type MessageTriggerDraft } from './message-trigger-draft';
import { registrationResult } from './registration-result';
import { draftPatcher } from './use-draft-form';
import { useRegistrationResult } from './use-registration-results';

/**
 * A command leaf becomes a message trigger (#172): which leaf (a command
 * with subcommands has several), where the trigger goes — the command's
 * own section by default — and its pattern. The dialog lists what the
 * leaf loses before the admin confirms. The trigger is stored first; then
 * the command is registered again without the leaf, or removed from
 * Discord when it was its last. What Discord answered stays with the
 * command's card, or — when the command is gone — shows as a toast.
 */
const props = defineProps<{
    visible: boolean;
    command: CommandView;
    guildNames: ReadonlyMap<string, string>;
    /** Audience Groups some trigger already uses. */
    groupNames: readonly string[];
}>();

const emit = defineEmits<{
    (e: 'close'): void;
    /** The leaf is this message trigger now. */
    (e: 'converted', trigger: MessageTriggerView): void;
    (e: 'reload'): void;
}>();

const { t } = useI18n();
const toast = useToastStore();

const LAYOUT: TriggerFormLayout = {
    kinds: CONVERT_LOCATION_KINDS,
    lockGuild: false,
    lockChannel: false,
    description: false,
};

/** The only leaf goes without asking; of several, the admin picks one. */
const firstPick = () => (props.command.leaves.length === 1 ? props.command.leaves[0].id : null);
const leafId = ref<number | null>(firstPick());
const leaf = computed(() => props.command.leaves.find((l) => l.id === leafId.value) ?? null);
// the picked leaf left the command (a reload, another admin): pick again
watch(
    () => props.command.leaves,
    () => {
        if (leaf.value === null) leafId.value = firstPick();
    }
);
const draft = ref<MessageTriggerDraft>(convertedMessageDraft(props.command));
const applyPatch = draftPatcher(draft);

const errors = ref<FormErrors>(NO_ERRORS);
const converting = ref(false);
const schema = ref<Record<string, unknown> | null>(null);

watch(
    () => props.visible,
    (visible) => {
        if (!visible) return;
        leafId.value = firstPick();
        draft.value = convertedMessageDraft(props.command);
        errors.value = NO_ERRORS;
        getBehaviorSchemas()
            .then((s) => (schema.value = s.convertTrigger ?? null))
            .catch(() => undefined);
    },
    { immediate: true }
);
watch(leafId, () => {
    if (errors.value.fields.leaf) errors.value = NO_ERRORS;
});

const leafOptions = computed<SelectOption<number>[]>(() =>
    props.command.leaves.map((l) => ({ value: l.id, label: `${commandPath(props.command.name, l.subcommand)} · ${l.title}` }))
);

const losses = computed(() => (leaf.value ? toMessageLosses(props.command, leaf.value, draft.value) : []));

/** What the server would refuse in the draft: a location without its ids, the served schema, a broken regex. */
function check(): FormErrors {
    if (!leaf.value) return { fields: { leaf: t('behaviors.validation.required') }, general: null };
    const fields = fieldsWithErrorLine(draft.value, LAYOUT);
    const body = toMessageBody(draft.value);
    if (!body) {
        const field = draft.value.guildId.trim() === '' ? 'guildId' : 'channelId';
        return { fields: { [field]: t('behaviors.validation.required') }, general: null };
    }
    const found: FormErrors = schema.value
        ? errorsFromIssues(t, checkAgainstSchema(schema.value, { to: 'message', ...body, ifUpdatedAt: leaf.value.updatedAt }), fields)
        : { fields: {}, general: null };
    if (body.patternKind === 'regex' && previewMatch('regex', body.patternValue, '') === 'invalid') {
        found.fields.patternValue ??= t('behaviors.trigger.preview.invalid');
    }
    return found;
}

async function convert() {
    if (converting.value) return;
    const found = check();
    errors.value = found;
    const body = toMessageBody(draft.value);
    const picked = leaf.value;
    if (!picked || !body || Object.keys(found.fields).length > 0 || found.general) return;
    converting.value = true;
    try {
        const result = await convertToMessage(picked.id, { ...body, ifUpdatedAt: picked.updatedAt });
        const outcome = registrationResult(t, result.registration, props.guildNames);
        if (props.command.leaves.length > 1) {
            // the command stays: its card says what Discord did with it
            commandRegistration.value = outcome;
        } else {
            toast.show(
                [t('behaviors.convertTrigger.toMessage.commandGone', { command: props.command.name }), outcome.headline, outcome.detail]
                    .filter(Boolean)
                    .join(' '),
                outcome.tone === 'ok' ? 'success' : 'warn'
            );
        }
        emit('converted', result.behavior);
    } catch (err) {
        if (isStale(err)) {
            errors.value = { fields: {}, general: t('behaviors.convertTrigger.stale') };
            emit('reload');
        } else {
            errors.value = errorsFromRefusal(t, err, fieldsWithErrorLine(draft.value, LAYOUT));
        }
    } finally {
        converting.value = false;
    }
}

const commandRegistration = useRegistrationResult(() => props.command.id);
</script>

<template>
    <AppModal
        :visible="visible"
        :title="t('behaviors.convertTrigger.toMessage.title', { command: command.name })"
        :close-label="t('common.close')"
        width="min(640px, 95vw)"
        @close="emit('close')"
    >
        <form data-test="convert-message-dialog" @submit.prevent="convert">
            <Stack gap="3">
                <p class="intro">{{ t('behaviors.convertTrigger.toMessage.intro') }}</p>

                <label v-if="command.leaves.length > 1" class="field">
                    <span class="field-label">{{ t('behaviors.convertTrigger.toMessage.leaf') }}</span>
                    <AppSelectField
                        :model-value="leafId ?? 0"
                        :options="leafOptions"
                        :placeholder="t('behaviors.convertTrigger.toMessage.leafPlaceholder')"
                        :drawer-title="t('behaviors.convertTrigger.toMessage.leaf')"
                        data-test="convert-leaf"
                        @update:model-value="leafId = $event"
                    />
                    <p v-if="errors.fields.leaf" class="field-error" data-test="leaf-error">{{ errors.fields.leaf }}</p>
                </label>

                <MessageTriggerFields
                    :draft="draft"
                    :kinds="LAYOUT.kinds"
                    :errors="errors.fields"
                    :group-names="groupNames"
                    @patch="applyPatch"
                />

                <ConvertLosses v-if="leaf" :losses="losses" />

                <p v-if="errors.general" class="error" role="alert" data-test="general-error">{{ errors.general }}</p>

                <footer class="footer">
                    <AppButton variant="secondary" @click="emit('close')">{{ t('common.cancel') }}</AppButton>
                    <AppButton type="submit" data-test="convert-submit" :loading="converting" :disabled="converting">
                        {{ t('behaviors.convertTrigger.submit') }}
                    </AppButton>
                </footer>
            </Stack>
        </form>
    </AppModal>
</template>

<style scoped>
.intro { margin: 0; color: var(--text-muted); line-height: 1.6; font-size: 0.9rem; }
.field { display: flex; flex-direction: column; gap: 0.25rem; min-width: 0; }
.field-label { font-size: 0.75rem; color: var(--text-muted); font-weight: 600; }
.field-error { margin: 0; font-size: 0.75rem; color: var(--danger); }
.error { margin: 0; font-size: 0.82rem; color: var(--danger); }
.footer { display: flex; justify-content: flex-end; gap: 0.5rem; }
</style>

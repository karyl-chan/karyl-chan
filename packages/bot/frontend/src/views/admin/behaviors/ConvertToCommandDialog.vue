<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { AppButton, AppModal, AppSelectField, AppTextField, Stack, type SelectOption } from '@karyl-chan/ui';
import {
    convertToCommand,
    getBehaviorSchemas,
    type BehaviorSchemas,
    type CommandView,
    type MessageTriggerView,
} from '../../../api/behavior';
import CommandRegistrationResult from './CommandRegistrationResult.vue';
import CommandVisibilityFields from './CommandVisibilityFields.vue';
import ConvertLosses from './ConvertLosses.vue';
import { NO_ERRORS, errorsFromRefusal, isStale, type FormErrors } from './behavior-errors';
import { commandDraftErrors, commandFieldsWithErrorLine } from './command-check';
import { commandPath, type CommandDraft } from './command-draft';
import {
    commandNameOf,
    commandsWithSubcommands,
    convertedCommandDraft,
    singleCommands,
    toCommandBody,
    toCommandLosses,
    type ToCommandTarget,
} from './convert-trigger-draft';
import { checkAgainstSchema, issueMessage, type JsonSchema } from './form-schema';
import {
    isRegistrationRefusal,
    registrationFailure,
    registrationResult,
    type RegistrationResult,
} from './registration-result';
import { draftPatcher } from './use-draft-form';
import { useRegistrationResult } from './use-registration-results';

/**
 * A message trigger becomes a command leaf (#172): a new command — its
 * name from the title, its visibility the one a new command gets in the
 * trigger's section — or one more subcommand of a command that already
 * has subcommands. The dialog lists what the trigger loses before the
 * admin confirms (ConvertLosses). Discord registers the command before
 * anything is stored: a refusal shows here and the trigger stays as it
 * was. Once through, the command's card (where the page goes next) shows
 * what Discord answered.
 */
const props = defineProps<{
    visible: boolean;
    trigger: MessageTriggerView;
    /** Every command on the page: the ones with subcommands can take this one. */
    commands: readonly CommandView[];
    guildNames: ReadonlyMap<string, string>;
}>();

const emit = defineEmits<{
    (e: 'close'): void;
    /** The behavior is a leaf of this command now. */
    (e: 'converted', command: CommandView): void;
    /** The list is out of date (the trigger changed since it loaded). */
    (e: 'reload'): void;
}>();

const { t } = useI18n();

type TargetKind = ToCommandTarget['kind'];
const targetKind = ref<TargetKind>('new');
const command = ref<CommandDraft>(convertedCommandDraft(props.trigger));
const patchCommand = draftPatcher(command);
const existingId = ref<number | null>(null);
const subcommandName = ref('');

/** A name is judged once the admin typed in it, or pressed 轉換 — not while it is the default. */
const touched = ref({ name: false, subcommandName: false });
const attempted = ref(false);
/** The title made no name (a CJK title): the field says what a name may hold. */
const nameDefaultEmpty = ref(false);

const errors = ref<FormErrors>(NO_ERRORS);
const refusal = ref<RegistrationResult | null>(null);
const converting = ref(false);
const schemas = ref<BehaviorSchemas | null>(null);

const candidates = computed(() => commandsWithSubcommands(props.commands));
const single = computed(() => singleCommands(props.commands));

watch(
    () => props.visible,
    (visible) => {
        if (!visible) return;
        targetKind.value = 'new';
        command.value = convertedCommandDraft(props.trigger);
        existingId.value = candidates.value[0]?.id ?? null;
        subcommandName.value = commandNameOf(props.trigger.title);
        nameDefaultEmpty.value = subcommandName.value === '';
        touched.value = { name: false, subcommandName: false };
        attempted.value = false;
        errors.value = NO_ERRORS;
        refusal.value = null;
        getBehaviorSchemas()
            .then((s) => (schemas.value = s))
            .catch(() => undefined);
    },
    { immediate: true }
);
watch(targetKind, () => {
    attempted.value = false;
    errors.value = NO_ERRORS;
    refusal.value = null;
});

/** One branch of the served body's `command` (0: a new command, 1: an existing one). */
function targetSchema(branch: 0 | 1): JsonSchema | null {
    const properties = schemas.value?.convertTrigger?.properties as Record<string, JsonSchema> | undefined;
    const anyOf = properties?.command?.anyOf as JsonSchema[] | undefined;
    return anyOf?.[branch] ?? null;
}

const EXISTING_FIELDS = ['existingId', 'subcommandName'];

/** What the server would refuse: the served schema, Discord's visibility rules; an empty name is "required". */
const draftErrors = computed<Record<string, string>>(() => {
    const required = t('behaviors.validation.required');
    if (targetKind.value === 'new') {
        const schema = (targetSchema(0)?.properties as Record<string, JsonSchema> | undefined)?.new ?? null;
        const found = { ...commandDraftErrors(t, command.value, schema).fields };
        if (command.value.name.trim() === '') found.name = required;
        return found;
    }
    const found: Record<string, string> = {};
    if (existingId.value === null) found.existingId = required;
    const schema = targetSchema(1);
    const name = subcommandName.value.trim();
    if (name === '') found.subcommandName = required;
    else if (schema) {
        const issue = checkAgainstSchema(schema, { existingId: existingId.value ?? 1, subcommandName: name }).subcommandName;
        if (issue) found.subcommandName = issueMessage(t, issue);
    }
    return found;
});
/** The errors on screen: a name's only once it is judged (see `touched`). */
const liveErrors = computed<Record<string, string>>(() => {
    const found = { ...draftErrors.value };
    for (const field of ['name', 'subcommandName'] as const) {
        if (!touched.value[field] && !attempted.value) delete found[field];
    }
    return found;
});
const fieldErrors = computed(() => ({ ...errors.value.fields, ...liveErrors.value }));

const target = computed<ToCommandTarget>(() =>
    targetKind.value === 'new'
        ? { kind: 'new', command: command.value }
        : { kind: 'existing', commandId: existingId.value, subcommandName: subcommandName.value }
);

const candidateOptions = computed<SelectOption<number>[]>(() =>
    candidates.value.map((c) => ({ value: c.id, label: commandPath(c.name) }))
);
const chosen = computed(() => candidates.value.find((c) => c.id === existingId.value) ?? null);
const path = computed(() =>
    targetKind.value === 'new'
        ? commandPath(command.value.name.trim() || '…')
        : commandPath(chosen.value?.name ?? '…', subcommandName.value.trim() || '…')
);

const losses = computed(() => toCommandLosses(props.trigger));

// the card of the command this behavior lands on shows what Discord answered
const landedOn = ref(0);
const landedRegistration = useRegistrationResult(() => landedOn.value);

/** `command.new.name`, `command.subcommandName` → the dialog's own field: every target field comes under `command.`. */
const formField = (field: string) => field.replace(/^command\.(new\.)?/, '');

function setName(name: string) {
    touched.value = { ...touched.value, name: true };
    patchCommand({ name });
}

function setSubcommandName(name: string) {
    touched.value = { ...touched.value, subcommandName: true };
    subcommandName.value = name;
}

const nameHint = computed(() =>
    nameDefaultEmpty.value ? t('behaviors.convertTrigger.toCommand.nameFromTitleEmpty') : t('behaviors.command.nameHint')
);

const blocked = computed(() => converting.value || Object.keys(liveErrors.value).length > 0);

async function convert() {
    attempted.value = true;
    if (blocked.value) return;
    converting.value = true;
    errors.value = NO_ERRORS;
    refusal.value = null;
    try {
        const result = await convertToCommand(props.trigger.id, {
            ...toCommandBody(target.value),
            ifUpdatedAt: props.trigger.updatedAt,
        });
        landedOn.value = result.command.id;
        landedRegistration.value = registrationResult(t, result.registration, props.guildNames);
        emit('converted', result.command);
    } catch (err) {
        if (isRegistrationRefusal(err)) {
            refusal.value = registrationFailure(t, err, props.guildNames);
        } else if (isStale(err)) {
            errors.value = { fields: {}, general: t('behaviors.convertTrigger.stale') };
            emit('reload');
        } else {
            const fields = targetKind.value === 'new' ? commandFieldsWithErrorLine(command.value) : EXISTING_FIELDS;
            errors.value = errorsFromRefusal(t, err, fields, formField);
        }
    } finally {
        converting.value = false;
    }
}

</script>

<template>
    <AppModal
        :visible="visible"
        :title="t('behaviors.convertTrigger.toCommand.title', { title: trigger.title })"
        :close-label="t('common.close')"
        width="min(640px, 95vw)"
        @close="emit('close')"
    >
        <form data-test="convert-command-dialog" @submit.prevent="convert">
            <Stack gap="3">
                <p class="intro">{{ t('behaviors.convertTrigger.toCommand.intro') }}</p>

                <Stack gap="1">
                    <span id="ct-target" class="field-label">{{ t('behaviors.convertTrigger.toCommand.target') }}</span>
                    <div class="choice-grid" role="radiogroup" aria-labelledby="ct-target">
                        <button
                            v-for="k in (['new', 'existing'] as const)"
                            :key="k"
                            type="button"
                            role="radio"
                            :data-test="`target-${k}`"
                            :class="['choice', { on: targetKind === k }]"
                            :aria-checked="targetKind === k ? 'true' : 'false'"
                            :disabled="k === 'existing' && candidates.length === 0"
                            @click="targetKind = k"
                        >
                            {{ t(`behaviors.convertTrigger.toCommand.targets.${k}`) }}
                        </button>
                    </div>
                    <p v-if="single.length > 0 || candidates.length === 0" class="hint" data-test="existing-note">
                        {{
                            candidates.length === 0
                                ? t('behaviors.convertTrigger.toCommand.noExisting')
                                : t('behaviors.convertTrigger.toCommand.singleNote', {
                                      commands: single.map((c) => commandPath(c.name)).join('、'),
                                  })
                        }}
                    </p>
                </Stack>

                <template v-if="targetKind === 'new'">
                    <div class="grid">
                        <AppTextField
                            class="mono"
                            data-test="convert-command-name"
                            :model-value="command.name"
                            :label="t('behaviors.command.name')"
                            :hint="nameHint"
                            :error="fieldErrors.name"
                            @update:model-value="setName(String($event))"
                        />
                        <AppTextField
                            :model-value="command.description"
                            :label="t('behaviors.command.description')"
                            :hint="t('behaviors.command.descriptionHint')"
                            :error="fieldErrors.description"
                            @update:model-value="patchCommand({ description: String($event) })"
                        />
                    </div>
                    <CommandVisibilityFields
                        :draft="command"
                        :errors="fieldErrors"
                        :section="null"
                        :guild-names="guildNames"
                        @patch="patchCommand"
                    />
                </template>

                <div v-else class="grid">
                    <label class="field">
                        <span class="field-label">{{ t('behaviors.convertTrigger.toCommand.existing') }}</span>
                        <AppSelectField
                            :model-value="existingId ?? 0"
                            :options="candidateOptions"
                            :drawer-title="t('behaviors.convertTrigger.toCommand.existing')"
                            data-test="convert-existing"
                            @update:model-value="existingId = $event"
                        />
                        <p v-if="fieldErrors.existingId" class="field-error">{{ fieldErrors.existingId }}</p>
                    </label>
                    <AppTextField
                        :model-value="subcommandName"
                        class="mono"
                        data-test="convert-subcommand"
                        :label="t('behaviors.convertTrigger.toCommand.subcommand')"
                        :hint="nameHint"
                        :error="fieldErrors.subcommandName"
                        @update:model-value="setSubcommandName(String($event))"
                    />
                </div>

                <p class="path" data-test="convert-path">
                    {{ t('behaviors.convertTrigger.becomes') }} <code>{{ path }}</code>
                </p>

                <ConvertLosses :losses="losses" />

                <CommandRegistrationResult v-if="refusal" :result="refusal" @dismiss="refusal = null" />
                <p v-if="errors.general" class="error" role="alert" data-test="general-error">{{ errors.general }}</p>

                <footer class="footer">
                    <AppButton variant="secondary" @click="emit('close')">{{ t('common.cancel') }}</AppButton>
                    <AppButton type="submit" data-test="convert-submit" :loading="converting" :disabled="blocked">
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
.hint { margin: 0; font-size: 0.78rem; line-height: 1.5; color: var(--text-muted); }
.grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr));
    gap: 0.6rem 1rem;
}
.mono :deep(input) { font-family: var(--font-mono, ui-monospace, monospace); }
.choice-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0.4rem; }
.choice {
    min-height: 2.25rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg-page);
    color: var(--text);
    font: inherit;
    font-size: 0.86rem;
    cursor: pointer;
}
.choice.on { border-color: var(--accent); background: var(--accent); color: var(--accent-contrast, #fff); }
.choice:disabled { cursor: not-allowed; border-style: dashed; background: transparent; color: var(--text-muted); }
.path { margin: 0; font-size: 0.85rem; }
.path code { color: var(--text-strong); }
.error { margin: 0; font-size: 0.82rem; color: var(--danger); }
.footer { display: flex; justify-content: flex-end; gap: 0.5rem; }
</style>

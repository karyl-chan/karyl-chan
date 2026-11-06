<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { AppSelectField, AppTextField, Stack, type SelectOption } from '@karyl-chan/ui';
import type { BehaviorSection, LoginPatternKind } from '../../../api/behavior';
import CommandVisibilityFields from './CommandVisibilityFields.vue';
import type { CommandDraft } from './command-draft';
import {
    LOGIN_COMMAND_REQUIRED,
    LOGIN_PATTERN_KINDS,
    loginCommandDraftOf,
    type LoginTriggerDraft,
} from './login-trigger-draft';
import { previewMatch } from './message-trigger-draft';

/**
 * The fields of the system login's trigger, for the kind the draft is:
 * a bot DM pattern with the sample DM it must match, or a global command
 * that keeps guild install and bot DMs. Shared by the card (an edit
 * within the same kind) and the switch dialog (the new trigger, #172),
 * so there is one login trigger editor.
 */
const props = defineProps<{
    draft: LoginTriggerDraft;
    errors: Record<string, string>;
    /** The section the saved login is in. */
    section: BehaviorSection | null;
    guildNames: ReadonlyMap<string, string>;
}>();

const emit = defineEmits<{ (e: 'patch', patch: Partial<LoginTriggerDraft>): void }>();

const { t } = useI18n();

const patternKindOptions = computed<SelectOption<LoginPatternKind>[]>(() =>
    LOGIN_PATTERN_KINDS.map((k) => ({ value: k, label: t(`behaviors.trigger.kind.${k}`) }))
);

const visibilityDraft = computed<CommandDraft>(() => loginCommandDraftOf(props.draft));
function patchVisibility(patch: Partial<CommandDraft>) {
    const next: Partial<LoginTriggerDraft> = {};
    if (patch.integrationTypes) next.integrationTypes = patch.integrationTypes;
    if (patch.contexts) next.contexts = patch.contexts;
    emit('patch', next);
}

/** Whether the sample DM would log in — as Discord delivers it, trimmed. */
const preview = computed(() =>
    props.draft.sample.trim() === ''
        ? null
        : previewMatch(props.draft.patternKind, props.draft.patternValue, props.draft.sample.trim())
);
</script>

<template>
    <Stack v-if="draft.kind === 'message'" gap="3">
        <div class="grid">
            <label class="field">
                <span class="field-label">{{ t('behaviors.trigger.patternKind') }}</span>
                <AppSelectField
                    :model-value="draft.patternKind"
                    :options="patternKindOptions"
                    :drawer-title="t('behaviors.trigger.patternKind')"
                    @update:model-value="emit('patch', { patternKind: $event })"
                />
                <p v-if="errors.patternKind" class="field-error">{{ errors.patternKind }}</p>
            </label>
            <AppTextField
                class="mono"
                data-test="login-pattern"
                :model-value="draft.patternValue"
                :label="t('behaviors.trigger.patternValue')"
                :error="errors.patternValue"
                @update:model-value="emit('patch', { patternValue: String($event) })"
            />
        </div>
        <div class="try">
            <AppTextField
                data-test="login-sample"
                :model-value="draft.sample"
                :label="t('behaviors.system.sample')"
                :hint="t('behaviors.system.sampleHint')"
                :error="errors.sample"
                @update:model-value="emit('patch', { sample: String($event) })"
            />
            <span v-if="preview && !errors.sample" role="status" :class="['try-result', preview]">
                {{ t(`behaviors.trigger.preview.${preview}`) }}
            </span>
        </div>
        <p class="hint">{{ t('behaviors.system.messageNote') }}</p>
    </Stack>

    <Stack v-else gap="3">
        <div class="grid">
            <AppTextField
                class="mono"
                data-test="login-name"
                :model-value="draft.name"
                :label="t('behaviors.system.commandName')"
                :hint="t('behaviors.command.nameHint')"
                :error="errors.name"
                @update:model-value="emit('patch', { name: String($event) })"
            />
            <AppTextField
                :model-value="draft.description"
                :label="t('behaviors.system.commandDescription')"
                :hint="t('behaviors.command.descriptionHint')"
                :error="errors.description"
                @update:model-value="emit('patch', { description: String($event) })"
            />
        </div>
        <CommandVisibilityFields
            :draft="visibilityDraft"
            :errors="errors"
            :section="section"
            :guild-names="guildNames"
            global-only
            :required="LOGIN_COMMAND_REQUIRED"
            :required-reason="t('behaviors.system.mustKeep')"
            @patch="patchVisibility"
        />
        <p class="hint">{{ t('behaviors.system.commandNote') }}</p>
    </Stack>
</template>

<style scoped>
.grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr));
    gap: 0.6rem 1rem;
}
.field { display: flex; flex-direction: column; gap: 0.25rem; min-width: 0; }
.field-label { font-size: 0.75rem; color: var(--text-muted); font-weight: 600; }
.field-error { margin: 0; font-size: 0.75rem; color: var(--danger); }
.mono :deep(input) { font-family: var(--font-mono, ui-monospace, monospace); }
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
</style>

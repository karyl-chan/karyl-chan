<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { AppSelectField, AppTextField, Stack, type SelectOption } from '@karyl-chan/ui';
import type { BehaviorAudienceKind, BehaviorPatternKind } from '../../../api/behavior';
import TriggerLocationFields from './TriggerLocationFields.vue';
import { previewCaptures, previewMatch, type MessageTriggerDraft } from './message-trigger-draft';
import type { LocationKind } from './message-trigger-location';

/**
 * The trigger half of a Message Trigger form (board 7 「觸發」 and
 * 「對象」): where, which pattern, the try-it box, the guild-only and
 * DM-only settings. Shared by the card editor and the new-behavior dialog,
 * so there is one trigger editor.
 */
const props = defineProps<{
    draft: MessageTriggerDraft;
    kinds: readonly LocationKind[];
    lockGuild?: boolean;
    lockChannel?: boolean;
    errors: Record<string, string>;
    /** Audience Groups some trigger already uses. */
    groupNames: readonly string[];
    /**
     * Set when saving would move the trigger to another section; `public`
     * when it leaves bot DMs, so replies would show in a channel (board 7).
     */
    moved?: { section: string; public: boolean } | null;
}>();

const emit = defineEmits<{ (e: 'patch', patch: Partial<MessageTriggerDraft>): void }>();

const { t } = useI18n();

function update(patch: Partial<MessageTriggerDraft>) {
    emit('patch', patch);
}

const inDm = computed(() => props.draft.locationKind === 'bot_dm');

// computed so the labels follow a language switch (#110)
const patternKindOptions = computed<SelectOption<BehaviorPatternKind>[]>(() =>
    (['startswith', 'endswith', 'regex'] as const).map((k) => ({ value: k, label: t(`behaviors.trigger.kind.${k}`) }))
);
const audienceOptions = computed<SelectOption<BehaviorAudienceKind>[]>(() =>
    (['all', 'user', 'group'] as const).map((k) => ({ value: k, label: t(`behaviors.audience.${k}`) }))
);

const NEW_GROUP = '\u0000new';
const typingNewGroup = ref(false);
const isNewGroup = computed(
    () =>
        typingNewGroup.value ||
        (props.draft.audienceGroupName !== '' && !props.groupNames.includes(props.draft.audienceGroupName))
);
const groupOptions = computed<SelectOption<string>[]>(() => [
    ...props.groupNames.map((g) => ({ value: g, label: g })),
    { value: NEW_GROUP, label: t('behaviors.audience.newGroup') },
]);
const groupChoice = computed({
    get: () => (isNewGroup.value ? NEW_GROUP : props.draft.audienceGroupName),
    set: (value: string) => {
        typingNewGroup.value = value === NEW_GROUP;
        update({ audienceGroupName: value === NEW_GROUP ? '' : value });
    },
});

const tryText = ref('');
const preview = computed(() => {
    const result = previewMatch(props.draft.patternKind, props.draft.patternValue, tryText.value);
    // a broken regex is worth saying before anything is typed
    return tryText.value === '' && result !== 'invalid' ? null : result;
});
/** The groups the service would get in `_meta.captures` (board 7). */
const captured = computed(() =>
    preview.value === 'match'
        ? previewCaptures(props.draft.patternKind, props.draft.patternValue, tryText.value)
              .map((value, i) => t('behaviors.trigger.preview.group', { n: i + 1, value: value ?? '' }))
              .join(t('behaviors.trigger.preview.groupSeparator'))
        : ''
);
</script>

<template>
    <Stack gap="2">
        <h4 class="part">{{ t('behaviors.trigger.title') }}</h4>
        <TriggerLocationFields
            :draft="draft"
            :kinds="kinds"
            :lock-guild="lockGuild"
            :lock-channel="lockChannel"
            :errors="errors"
            @patch="emit('patch', $event)"
        />
        <p v-if="moved" class="moved" role="status" data-test="moved">
            {{ t('behaviors.trigger.moved', { section: moved.section }) }}
            <template v-if="moved.public">{{ t('behaviors.trigger.movedPublic') }}</template>
        </p>

        <div class="grid">
            <label class="field">
                <span class="field-label">{{ t('behaviors.trigger.patternKind') }}</span>
                <AppSelectField
                    :model-value="draft.patternKind"
                    :options="patternKindOptions"
                    :drawer-title="t('behaviors.trigger.patternKind')"
                    @update:model-value="update({ patternKind: $event })"
                />
            </label>
            <AppTextField
                class="mono"
                :model-value="draft.patternValue"
                :label="t('behaviors.trigger.patternValue')"
                :placeholder="t('behaviors.trigger.patternPlaceholder')"
                :error="errors.patternValue"
                @update:model-value="update({ patternValue: String($event) })"
            />
        </div>

        <div class="try">
            <AppTextField v-model="tryText" :label="t('behaviors.trigger.try')" :placeholder="t('behaviors.trigger.tryPlaceholder')" />
            <span v-if="preview" role="status" :class="['try-result', preview]" data-test="try-result">
                {{
                    captured
                        ? t('behaviors.trigger.preview.matchWithGroups', { groups: captured })
                        : t(`behaviors.trigger.preview.${preview}`)
                }}
            </span>
        </div>

        <label v-if="!inDm" class="check">
            <input type="checkbox" :checked="draft.ignoreBots" @change="update({ ignoreBots: ($event.target as HTMLInputElement).checked })" />
            {{ t('behaviors.trigger.ignoreBots') }}
        </label>
        <label class="check">
            <input type="checkbox" :checked="draft.stopOnMatch" @change="update({ stopOnMatch: ($event.target as HTMLInputElement).checked })" />
            {{ t('behaviors.trigger.stopOnMatch') }}
        </label>

        <template v-if="inDm">
            <h4 class="part">{{ t('behaviors.audience.title') }}</h4>
            <div class="grid">
                <label class="field">
                    <span class="field-label">{{ t('behaviors.audience.label') }}</span>
                    <AppSelectField
                        :model-value="draft.audienceKind"
                        :options="audienceOptions"
                        :drawer-title="t('behaviors.audience.label')"
                        @update:model-value="update({ audienceKind: $event })"
                    />
                    <p v-if="errors.audienceKind" class="field-error">{{ errors.audienceKind }}</p>
                </label>
                <AppTextField
                    v-if="draft.audienceKind === 'user'"
                    :model-value="draft.audienceUserId"
                    :label="t('behaviors.audience.user')"
                    :hint="t('behaviors.location.idHint')"
                    :error="errors.audienceUserId"
                    inputmode="numeric"
                    @update:model-value="update({ audienceUserId: String($event) })"
                />
                <template v-if="draft.audienceKind === 'group'">
                    <label class="field">
                        <span class="field-label">{{ t('behaviors.audience.group') }}</span>
                        <AppSelectField
                            v-model="groupChoice"
                            :options="groupOptions"
                            :placeholder="t('behaviors.audience.groupPlaceholder')"
                            :drawer-title="t('behaviors.audience.group')"
                        />
                        <p v-if="errors.audienceGroupName && !isNewGroup" class="field-error">{{ errors.audienceGroupName }}</p>
                    </label>
                    <AppTextField
                        v-if="isNewGroup"
                        :model-value="draft.audienceGroupName"
                        :label="t('behaviors.audience.newGroupName')"
                        :hint="t('behaviors.audience.newGroupHint')"
                        :error="errors.audienceGroupName"
                        @update:model-value="update({ audienceGroupName: String($event) })"
                    />
                </template>
            </div>
            <slot v-if="draft.audienceKind === 'group'" name="group-members" />
        </template>
    </Stack>
</template>

<style scoped>
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
.moved { margin: 0; font-size: 0.82rem; color: var(--text-strong); }
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
.check { display: flex; align-items: center; gap: 0.4rem; font-size: 0.86rem; min-height: 1.75rem; cursor: pointer; }
</style>

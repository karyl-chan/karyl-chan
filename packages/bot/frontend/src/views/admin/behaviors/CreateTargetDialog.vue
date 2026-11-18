<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { AppButton, AppModal, AppSelectField, AppTextField, Stack, type SelectOption } from '@karyl-chan/ui';
import {
    createBehaviorTarget,
    getBehaviorSchemas,
    type BehaviorTargetInput,
    type BehaviorTargetView,
} from '../../../api/behavior';
import TriggerLocationFields from './TriggerLocationFields.vue';
import { NO_ERRORS, errorsFromIssues, errorsFromRefusal, hasErrors, type FormErrors } from './behavior-errors';
import { checkAgainstSchema } from './form-schema';
import { emptyDraft, withLocationKind, type MessageTriggerDraft } from './message-trigger-draft';
import { draftPatcher } from './use-draft-form';

/**
 * "New target" (ADR 0004): a server, a channel, a user or a group the
 * admin wants behaviors for. It is listed as soon as it exists, before any
 * behavior is added to it. Servers and channels are picked from what the
 * bot can see (raw ids without guild access); the request is checked
 * against the server's own schema before it is sent.
 */
const props = defineProps<{ visible: boolean }>();

const emit = defineEmits<{
    (e: 'close'): void;
    (e: 'created', target: BehaviorTargetView): void;
}>();

const { t } = useI18n();

type Kind = BehaviorTargetInput['kind'];
const KINDS: readonly Kind[] = ['guild', 'channel', 'user', 'group'];

const kind = ref<Kind>('guild');
/** The server / channel pickers work on a trigger draft's location fields. */
const place = ref<MessageTriggerDraft>(emptyDraft({ kind: 'guild' }));
const patchPlace = draftPatcher(place);
const userId = ref('');
const name = ref('');
const errors = ref<FormErrors>(NO_ERRORS);
const creating = ref(false);

// Start fresh each time the dialog opens.
watch(
    () => props.visible,
    (visible) => {
        if (!visible) return;
        kind.value = 'guild';
        place.value = emptyDraft({ kind: 'guild' });
        userId.value = '';
        name.value = '';
        errors.value = NO_ERRORS;
    },
    { immediate: true }
);

watch(kind, (next) => {
    errors.value = NO_ERRORS;
    if (next === 'guild' || next === 'channel') place.value = withLocationKind(place.value, next);
});

const kindOptions = computed<SelectOption<Kind>[]>(() =>
    KINDS.map((k) => ({ value: k, label: t(`behaviors.target.create.kinds.${k}`) }))
);

/** The request fields the chosen kind takes — the ones with an error line on screen. */
const FIELDS: Record<Kind, readonly string[]> = {
    guild: ['guildId'],
    channel: ['guildId', 'channelId'],
    user: ['userId'],
    group: ['name'],
};

function body(): BehaviorTargetInput {
    switch (kind.value) {
        case 'guild':
            return { kind: 'guild', guildId: place.value.guildId.trim() };
        case 'channel':
            return { kind: 'channel', guildId: place.value.guildId.trim(), channelId: place.value.channelId.trim() };
        case 'user':
            return { kind: 'user', userId: userId.value.trim() };
        case 'group':
            return { kind: 'group', name: name.value.trim() };
    }
}

async function create() {
    if (creating.value) return;
    const input = body();
    const fields = FIELDS[input.kind];
    const schemas = await getBehaviorSchemas().catch(() => null);
    const found = schemas?.target
        ? errorsFromIssues(t, checkAgainstSchema(schemas.target, input), fields)
        : NO_ERRORS;
    errors.value = found;
    if (hasErrors(found)) return;

    creating.value = true;
    try {
        const { target } = await createBehaviorTarget(input);
        emit('created', target);
        emit('close');
    } catch (err) {
        errors.value = errorsFromRefusal(t, err, fields);
    } finally {
        creating.value = false;
    }
}
</script>

<template>
    <AppModal
        :visible="visible"
        :title="t('behaviors.target.create.title')"
        :close-label="t('common.close')"
        width="min(480px, 95vw)"
        @close="emit('close')"
    >
        <form data-test="create-target-form" @submit.prevent="create">
            <Stack gap="3">
                <label class="field">
                    <span class="field-label">{{ t('behaviors.target.create.kind') }}</span>
                    <AppSelectField
                        v-model="kind"
                        :options="kindOptions"
                        :drawer-title="t('behaviors.target.create.kind')"
                    />
                </label>

                <TriggerLocationFields
                    v-if="kind === 'guild' || kind === 'channel'"
                    :draft="place"
                    :kinds="[kind]"
                    :errors="errors.fields"
                    hide-kind
                    @patch="patchPlace"
                />

                <AppTextField
                    v-if="kind === 'user'"
                    v-model="userId"
                    data-test="target-user-id"
                    :label="t('behaviors.target.create.userId')"
                    :hint="t('behaviors.location.idHint')"
                    :error="errors.fields.userId"
                    inputmode="numeric"
                    :maxlength="20"
                    autofocus
                />

                <AppTextField
                    v-if="kind === 'group'"
                    v-model="name"
                    data-test="target-group-name"
                    :label="t('behaviors.target.create.groupName')"
                    :error="errors.fields.name"
                    :maxlength="200"
                    autofocus
                />

                <p v-if="errors.general" class="error" role="alert" data-test="general-error">{{ errors.general }}</p>

                <footer class="footer">
                    <AppButton type="button" variant="ghost" @click="emit('close')">{{ t('common.cancel') }}</AppButton>
                    <AppButton type="submit" :loading="creating" data-test="create-target-submit">
                        {{ t('behaviors.target.create.submit') }}
                    </AppButton>
                </footer>
            </Stack>
        </form>
    </AppModal>
</template>

<style scoped>
.field { display: flex; flex-direction: column; gap: 0.25rem; min-width: 0; }
.field-label { font-size: 0.75rem; color: var(--text-muted); font-weight: 600; }
.error { margin: 0; font-size: 0.85rem; color: var(--danger); }
.footer { display: flex; justify-content: flex-end; gap: 0.5rem; }
</style>

<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { AppSelectField, AppTextField, Stack, type SelectOption } from '@karyl-chan/ui';
import type { WebhookActionView } from '../../../api/behavior';
import SecretField from './SecretField.vue';
import type { AuthChoice, WebhookDraft } from './webhook-draft';

/**
 * The action half of a behavior form (board 7 「轉發設定」): the Action
 * Source — webhook for now; plugin actions come with phase 2 — its URL
 * and authentication, and the write-only secret of a saved webhook.
 * Shared by every form with a webhook action (message triggers, command
 * leaves).
 */
const props = defineProps<{
    draft: WebhookDraft;
    errors: Record<string, string>;
    /** The saved webhook (null while creating). */
    saved: WebhookActionView | null;
    /** The saved behavior the secret belongs to (null while creating). */
    behaviorId: number | null;
    /** A secret the last save generated — shown once. */
    issuedSecret: string | null;
}>();

const emit = defineEmits<{
    (e: 'patch', patch: Partial<WebhookDraft>): void;
    (e: 'rotated'): void;
}>();

const { t } = useI18n();

const authOptions = computed<SelectOption<AuthChoice>[]>(() =>
    (['hmac', 'token', 'none'] as const).map((k) => ({ value: k, label: t(`behaviors.action.auth.${k}`) }))
);

const savedAuth = computed<AuthChoice>(() => props.saved?.authMode ?? 'none');

/** What saving the chosen authentication will do to the secret. */
const authNote = computed(() => {
    const next = props.draft.authMode;
    if (next === 'none' && savedAuth.value !== 'none') return t('behaviors.action.authNoteDrop');
    if (next !== 'none' && (props.behaviorId === null || savedAuth.value === 'none')) {
        return t('behaviors.action.authNoteIssue');
    }
    return '';
});
</script>

<template>
    <Stack gap="2">
        <h4 class="part">{{ t('behaviors.action.title') }}</h4>
        <div class="grid">
            <div class="field">
                <span class="field-label">{{ t('behaviors.action.source') }}</span>
                <span class="fixed">{{ t('behaviors.action.sourceWebhook') }}</span>
                <span class="field-hint">{{ t('behaviors.action.sourcePluginLater') }}</span>
            </div>
            <AppTextField
                class="mono"
                :model-value="draft.webhookUrl"
                :label="t('behaviors.action.url')"
                placeholder="https://"
                :hint="t('behaviors.action.urlHint')"
                :error="errors['webhook.url']"
                inputmode="url"
                @update:model-value="emit('patch', { webhookUrl: String($event) })"
            />
            <label class="field">
                <span class="field-label">{{ t('behaviors.action.authLabel') }}</span>
                <AppSelectField
                    :model-value="draft.authMode"
                    :options="authOptions"
                    :drawer-title="t('behaviors.action.authLabel')"
                    @update:model-value="emit('patch', { authMode: $event })"
                />
                <span v-if="authNote" class="field-hint">{{ authNote }}</span>
                <p v-if="errors['webhook.authMode']" class="field-error">{{ errors['webhook.authMode'] }}</p>
            </label>
            <SecretField
                v-if="behaviorId !== null && (saved?.secretSet || issuedSecret)"
                :behavior-id="behaviorId"
                :secret-set="saved?.secretSet ?? false"
                :previous-secret-expires-at="saved?.previousSecretExpiresAt ?? null"
                :issued="issuedSecret"
                :disabled="draft.authMode === 'none'"
                @rotated="emit('rotated')"
            />
        </div>
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
    grid-template-columns: repeat(auto-fit, minmax(18rem, 1fr));
    gap: 0.6rem 1rem;
    align-items: start;
}
.field { display: flex; flex-direction: column; gap: 0.25rem; min-width: 0; }
.field-label { font-size: 0.75rem; color: var(--text-muted); font-weight: 600; }
.field-hint { font-size: 0.75rem; color: var(--text-muted); }
.field-error { margin: 0; font-size: 0.75rem; color: var(--danger); }
.fixed { font-size: 0.9rem; color: var(--text-strong); padding: 0.4rem 0 0; }
.mono :deep(input) { font-family: var(--font-mono, ui-monospace, monospace); }
</style>

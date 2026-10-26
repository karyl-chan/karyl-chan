<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { AppButton, useConfirm } from '@karyl-chan/ui';
import { rotateWebhookSecret } from '../../../api/behavior';
import OneTimeSecret from './OneTimeSecret.vue';
import { describeBehaviorError } from './behavior-errors';

/**
 * A webhook's secret, write-only (#99): the UI only knows whether one is
 * set. "Generate new secret" rotates it — the new one is shown once, the
 * replaced one keeps verifying until `previousSecretExpiresAt`.
 */
const props = defineProps<{
    behaviorId: number;
    secretSet: boolean;
    /** From the saved webhook: a rotation's grace period still running. */
    previousSecretExpiresAt: string | null;
    /** A secret the parent was just handed (create, turning auth on) — shown once. */
    issued: string | null;
    disabled?: boolean;
}>();

const emit = defineEmits<{
    (e: 'rotated', result: { secret: string; previousSecretExpiresAt: string }): void;
}>();

const { t, locale } = useI18n();
const { confirm } = useConfirm();

const revealed = ref<string | null>(props.issued);
watch(
    () => props.issued,
    (secret) => {
        if (secret) revealed.value = secret;
    }
);
const graceEnd = ref<string | null>(null);
const rotating = ref(false);
const error = ref<string | null>(null);

const graceUntil = computed(() => graceEnd.value ?? props.previousSecretExpiresAt);
const graceText = computed(() =>
    graceUntil.value
        ? t('behaviors.secret.grace', {
              time: new Date(graceUntil.value).toLocaleString(locale.value),
          })
        : ''
);

async function rotate() {
    const ok = await confirm({
        title: t('behaviors.secret.rotateTitle'),
        message: t('behaviors.secret.rotateMessage'),
        confirmLabel: t('behaviors.secret.rotate'),
        cancelLabel: t('common.cancel'),
    });
    if (!ok) return;
    rotating.value = true;
    error.value = null;
    try {
        const result = await rotateWebhookSecret(props.behaviorId);
        revealed.value = result.secret;
        graceEnd.value = result.previousSecretExpiresAt;
        emit('rotated', result);
    } catch (err) {
        error.value = describeBehaviorError(t, err);
    } finally {
        rotating.value = false;
    }
}
</script>

<template>
    <div :class="['secret-field', { revealed }]">
        <span class="label">{{ t('behaviors.secret.label') }}</span>
        <div class="box">
            <span class="status">{{ secretSet ? t('behaviors.secret.set') : t('behaviors.secret.unset') }}</span>
            <AppButton
                v-if="secretSet"
                size="sm"
                variant="secondary"
                data-test="rotate"
                :loading="rotating"
                :disabled="disabled || rotating"
                @click="rotate"
            >
                {{ t('behaviors.secret.rotate') }}
            </AppButton>
        </div>
        <p v-if="graceText" class="hint" data-test="grace">{{ graceText }}</p>
        <p v-if="error" class="error" role="alert">{{ error }}</p>
        <OneTimeSecret v-if="revealed" :secret="revealed" @dismiss="revealed = null" />
    </div>
</template>

<style scoped>
.secret-field {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    min-width: 0;
}
/* the one-time secret needs the whole row */
.secret-field.revealed { grid-column: 1 / -1; }
.label {
    font-size: 0.75rem;
    color: var(--text-muted);
    font-weight: 600;
}
.box {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    min-height: 2.1rem;
    padding: 0.2rem 0.25rem 0.2rem 0.6rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg-page);
}
.status {
    flex: 1;
    color: var(--text-muted);
    font-size: 0.88rem;
}
.hint {
    margin: 0;
    font-size: 0.75rem;
    color: var(--text-muted);
}
.error {
    margin: 0;
    font-size: 0.78rem;
    color: var(--danger);
}
</style>

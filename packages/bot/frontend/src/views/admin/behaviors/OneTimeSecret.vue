<script setup lang="ts">
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { Icon } from '@iconify/vue';
import { AppButton } from '@karyl-chan/ui';

/**
 * A webhook secret the bot just generated. The API returns it exactly
 * once (create, turning authentication on, rotation) and never again, so
 * this is the only time the admin can copy it; dismissing it drops it.
 */
defineProps<{ secret: string }>();
const emit = defineEmits<{ (e: 'dismiss'): void }>();

const { t } = useI18n();
const copied = ref(false);

async function copy(secret: string) {
    try {
        await navigator.clipboard.writeText(secret);
        copied.value = true;
    } catch {
        copied.value = false;
    }
}
</script>

<template>
    <div class="one-time" role="status">
        <p class="warning">
            <Icon icon="material-symbols:key-outline-rounded" width="16" height="16" aria-hidden="true" />
            {{ t('behaviors.secret.shownOnce') }}
        </p>
        <div class="row">
            <code class="value" data-test="secret-value">{{ secret }}</code>
            <AppButton size="sm" variant="secondary" icon="material-symbols:content-copy-outline-rounded" @click="copy(secret)">
                {{ copied ? t('behaviors.secret.copied') : t('behaviors.secret.copy') }}
            </AppButton>
            <AppButton size="sm" variant="ghost" data-test="secret-dismiss" @click="emit('dismiss')">
                {{ t('behaviors.secret.saved') }}
            </AppButton>
        </div>
    </div>
</template>

<style scoped>
.one-time {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    padding: 0.55rem 0.7rem;
    border: 1px solid var(--warn-text, var(--border));
    border-radius: var(--radius-sm);
    background: var(--bg-page);
}
.warning {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    margin: 0;
    font-size: 0.82rem;
    color: var(--warn-text, var(--text));
}
.row {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    flex-wrap: wrap;
}
.value {
    flex: 1;
    min-width: 12rem;
    font-size: 0.8rem;
    overflow-wrap: anywhere;
    user-select: all;
}
</style>

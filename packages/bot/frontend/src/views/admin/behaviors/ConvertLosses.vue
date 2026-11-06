<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import { Icon } from '@iconify/vue';
import type { ConvertLoss } from './convert-trigger-draft';

/**
 * Before a trigger conversion is confirmed (#172): what the behavior
 * loses or changes on the way, and what it keeps — its id, webhook,
 * secret, statistics and deliveries.
 */
defineProps<{ losses: readonly ConvertLoss[] }>();

const { t } = useI18n();
</script>

<template>
    <div class="losses" role="note" data-test="convert-losses">
        <p class="head">
            <Icon icon="material-symbols:warning-outline-rounded" width="16" height="16" aria-hidden="true" />
            {{ t('behaviors.convertTrigger.lossesTitle') }}
        </p>
        <ul>
            <li v-for="loss in losses" :key="loss.key" :data-loss="loss.key.split('.').pop()">
                {{ t(loss.key, loss.values ?? {}) }}
            </li>
        </ul>
        <p class="kept">{{ t('behaviors.convertTrigger.kept') }}</p>
    </div>
</template>

<style scoped>
.losses {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    padding: 0.6rem 0.8rem;
    border: 1px solid var(--warn-text, var(--border));
    border-radius: var(--radius-sm);
    font-size: 0.85rem;
    line-height: 1.6;
}
.head {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    margin: 0;
    font-weight: 600;
    color: var(--warn-text, var(--text));
}
ul { margin: 0; padding-left: 1.25rem; }
.kept { margin: 0; color: var(--text-muted); font-size: 0.8rem; }
</style>

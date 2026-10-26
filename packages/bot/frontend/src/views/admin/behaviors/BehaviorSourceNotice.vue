<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import { Icon } from '@iconify/vue';

/** Banner on the System Behavior: it cannot be added, deleted or disabled. */
const { t } = useI18n();
</script>

<template>
    <div class="source-notice">
        <Icon icon="material-symbols:settings-outline" width="16" height="16" class="notice-icon" aria-hidden="true" />
        <span class="notice-text">{{ t('behaviors.card.systemNotice') }}</span>
    </div>
</template>

<style scoped>
.source-notice {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.55rem 0.75rem;
    border-radius: var(--radius-sm);
    font-size: 0.85rem;
    border: 1px solid var(--border);
    background: var(--bg-page);
    color: var(--text-muted);
    flex-wrap: wrap;
}

.notice-icon {
    flex-shrink: 0;
    opacity: 0.85;
}

.notice-text {
    flex: 1;
    min-width: 0;
    color: inherit;
}
</style>

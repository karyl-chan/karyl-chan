<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import type { BehaviorStats, WebhookActionView } from '../../../api/behavior';
import { useRelativeTime } from '../../../composables/use-relative-time';

/** Read-only view of a behavior's action (built-in / webhook) and its stats. */
defineProps<{
    actionSource: 'builtin' | 'webhook';
    webhook: WebhookActionView | null;
    stats: BehaviorStats | null;
}>();

const { t } = useI18n();
const { relativeTime } = useRelativeTime();
</script>

<template>
    <dl class="details">
        <dt>{{ t('behaviors.card.action') }}</dt>
        <dd v-if="actionSource === 'builtin'">{{ t('behaviors.card.actionBuiltin') }}</dd>
        <dd v-else-if="webhook">
            <code class="url">{{ webhook.url ?? t('behaviors.card.webhookUrlUnreadable') }}</code>
            <span class="muted">
                · {{ webhook.authMode ? t(`behaviors.card.auth.${webhook.authMode}`) : t('behaviors.card.auth.none') }}
                · {{ webhook.secretSet ? t('behaviors.card.secretSet') : t('behaviors.card.secretUnset') }}
            </span>
        </dd>
        <dd v-else class="muted">{{ t('behaviors.card.actionMissing') }}</dd>

        <template v-if="stats">
            <dt>{{ t('behaviors.card.stats') }}</dt>
            <dd>
                {{ t('behaviors.card.statsLine', {
                    when: relativeTime(stats.lastFiredAt),
                    ok: stats.successCount,
                    fail: stats.failureCount,
                }) }}
                <span v-if="stats.lastError" class="last-error">
                    {{ t('behaviors.card.statsLastError', { error: stats.lastError }) }}
                </span>
            </dd>
        </template>
    </dl>
</template>

<style scoped>
.details {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 0.35rem 0.75rem;
    margin: 0;
    font-size: 0.85rem;
}
dt { color: var(--text-muted); }
dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
.url { font-size: 0.8rem; }
.muted { color: var(--text-muted); }
.last-error { display: block; color: var(--danger); }
</style>

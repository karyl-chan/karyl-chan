<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { Icon } from '@iconify/vue';
import { AppBadge, AppItemCard, AppToggle } from '@karyl-chan/ui';
import type { MessageTriggerView } from '../../../api/behavior';
import BehaviorActionDetails from './BehaviorActionDetails.vue';
import BehaviorSourceNotice from './BehaviorSourceNotice.vue';

/**
 * Read-only card for a Message Trigger (S3). Editing returns with the
 * write API (S4 / S5).
 */
const props = defineProps<{
    trigger: MessageTriggerView;
}>();

const { t } = useI18n();
const open = ref(false);

const isSystem = computed(() => props.trigger.systemKey !== null);
const unhealthy = computed(() => (props.trigger.stats?.consecutiveFailures ?? 0) >= 3);

const patternSummary = computed(() =>
    t(`behaviors.card.pattern.${props.trigger.patternKind}`, { value: props.trigger.patternValue })
);

const where = computed(() => {
    const tr = props.trigger;
    if (tr.surface === 'bot_dm') return t('behaviors.card.whereBotDm');
    if (tr.channelId) return t('behaviors.card.whereChannel', { guild: tr.guildId, channel: tr.channelId });
    if (tr.guildId) return t('behaviors.card.whereGuild', { guild: tr.guildId });
    return t('behaviors.card.whereGuildAll');
});

const audience = computed(() => {
    const tr = props.trigger;
    if (tr.audienceKind === 'user') return t('behaviors.card.audienceUser', { user: tr.audienceUserId });
    if (tr.audienceKind === 'group') return t('behaviors.card.audienceGroup', { group: tr.audienceGroupName });
    return t('behaviors.card.audienceAll');
});
</script>

<template>
    <AppItemCard
        :expanded="open"
        :disabled="!trigger.enabled"
        :accent-bar="isSystem ? 'neutral' : 'accent'"
        @update:expanded="open = $event"
    >
        <template #leading>
            <span class="lead" :title="isSystem ? t('behaviors.card.systemRowLocked') : undefined" aria-hidden="true">
                <Icon
                    :icon="isSystem ? 'material-symbols:lock-outline' : 'material-symbols:chat-outline-rounded'"
                    width="16" height="16"
                />
            </span>
        </template>

        <template #title>
            <span class="title">{{ trigger.title }}</span>
            <span class="summary">{{ patternSummary }}</span>
        </template>

        <template #trailing>
            <AppBadge size="sm" icon="material-symbols:article-outline">
                {{ t('behaviors.card.triggerMessage') }}
            </AppBadge>
            <AppBadge v-if="isSystem" size="sm" icon="material-symbols:settings-outline" :title="t('behaviors.card.tagSystem')">
                {{ t('behaviors.card.tagSystemShort') }}
            </AppBadge>
            <AppBadge v-if="trigger.stopOnMatch" size="sm" tone="warn" icon="material-symbols:stop-circle-outline-rounded" :title="t('behaviors.card.tagStop')">
                {{ t('behaviors.card.tagStopShort') }}
            </AppBadge>
            <AppBadge v-if="unhealthy" size="sm" tone="danger" icon="material-symbols:heart-broken-rounded" :title="trigger.stats?.lastError ?? ''">
                {{ t('behaviors.card.unhealthy') }}
            </AppBadge>
            <AppToggle
                :model-value="trigger.enabled"
                disabled
                :title="isSystem ? t('behaviors.card.toggleProtected') : t('behaviors.card.toggleReadOnly')"
                :aria-label="trigger.enabled ? t('behaviors.card.enabled') : t('behaviors.card.disabled')"
            />
        </template>

        <div class="body">
            <BehaviorSourceNotice v-if="isSystem" />
            <p v-if="trigger.description" class="description">{{ trigger.description }}</p>
            <dl class="details">
                <dt>{{ t('behaviors.card.where') }}</dt>
                <dd>{{ where }}</dd>
                <template v-if="trigger.surface === 'bot_dm'">
                    <dt>{{ t('behaviors.card.audience') }}</dt>
                    <dd>{{ audience }}</dd>
                </template>
                <template v-else>
                    <dt>{{ t('behaviors.card.ignoreBots') }}</dt>
                    <dd>{{ trigger.ignoreBots ? t('behaviors.card.yes') : t('behaviors.card.no') }}</dd>
                </template>
            </dl>
            <BehaviorActionDetails
                :action-source="trigger.actionSource"
                :webhook="trigger.webhook"
                :stats="trigger.stats"
            />
        </div>
    </AppItemCard>
</template>

<style scoped>
.lead {
    color: var(--text-muted);
    display: inline-flex;
    align-items: center;
    padding: 0.25rem;
}
.title {
    font-weight: 600;
    color: var(--text-strong);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex-shrink: 0;
    max-width: 50%;
}
.summary {
    color: var(--text-muted);
    font-size: 0.8rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
}
.body { display: flex; flex-direction: column; gap: 0.6rem; }
.description { margin: 0; color: var(--text); font-size: 0.88rem; }
.details {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 0.35rem 0.75rem;
    margin: 0;
    font-size: 0.85rem;
}
dt { color: var(--text-muted); }
dd { margin: 0; overflow-wrap: anywhere; }
</style>

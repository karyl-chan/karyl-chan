<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { MessageTriggerView } from '../../../api/behavior';
import BehaviorActionDetails from './BehaviorActionDetails.vue';
import BehaviorSourceNotice from './BehaviorSourceNotice.vue';
import { locationKindOf } from './message-trigger-location';
import { sectionLabel } from './section-labels';

/**
 * The System Behavior's message trigger, read-only: it cannot be edited,
 * deleted or disabled here (switching its trigger is S7, #139).
 */
const props = defineProps<{ trigger: MessageTriggerView; guildNames: ReadonlyMap<string, string> }>();

const { t } = useI18n();

const where = computed(() => {
    const kind = locationKindOf(props.trigger);
    const label = t(`behaviors.location.${kind}`);
    // one server / one channel: say which
    return kind === 'guild' || kind === 'channel'
        ? `${label} · ${sectionLabel(t, props.trigger.section, props.guildNames)}`
        : label;
});

const audience = computed(() => {
    const tr = props.trigger;
    if (tr.audienceKind === 'user') return t('behaviors.card.audienceUser', { user: tr.audienceUserId });
    if (tr.audienceKind === 'group') return t('behaviors.card.audienceGroup', { group: tr.audienceGroupName });
    return t('behaviors.audience.all');
});
</script>

<template>
    <BehaviorSourceNotice />
    <p v-if="trigger.description" class="description">{{ trigger.description }}</p>
    <dl class="details">
        <dt>{{ t('behaviors.location.label') }}</dt>
        <dd>{{ where }}</dd>
        <template v-if="trigger.surface === 'bot_dm'">
            <dt>{{ t('behaviors.audience.label') }}</dt>
            <dd>{{ audience }}</dd>
        </template>
    </dl>
    <BehaviorActionDetails :action-source="trigger.actionSource" :webhook="trigger.webhook" :stats="trigger.stats" />
</template>

<style scoped>
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

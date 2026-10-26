<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { Icon } from '@iconify/vue';
import { AppBadge, AppItemCard, AppToggle } from '@karyl-chan/ui';
import type { CommandLeafView, CommandView } from '../../../api/behavior';
import BehaviorActionDetails from './BehaviorActionDetails.vue';
import BehaviorSourceNotice from './BehaviorSourceNotice.vue';

/**
 * Read-only card for a Command (S3): the command's visibility settings and
 * its leaves — the root leaf, or one row per subcommand. Editing returns
 * with the write API (S4 / S6).
 */
const props = defineProps<{
    command: CommandView;
}>();

const { t } = useI18n();
const open = ref(false);

const isSystem = computed(
    () => props.command.isSystem || props.command.leaves.some((l) => l.systemKey !== null)
);
const anyEnabled = computed(() => props.command.leaves.some((l) => l.enabled));
const isRoot = computed(
    () => props.command.leaves.length === 1 && props.command.leaves[0].subcommand === ''
);
const unhealthy = computed(() =>
    props.command.leaves.some((l) => (l.stats?.consecutiveFailures ?? 0) >= 3)
);

function leafPath(leaf: CommandLeafView): string {
    return [props.command.name, leaf.subcommandGroup, leaf.subcommand].filter(Boolean).join(' ');
}

const registration = computed(() =>
    props.command.registration === 'guild'
        ? t('behaviors.card.registrationGuild', { guild: props.command.guildId })
        : t('behaviors.card.registrationGlobal')
);
</script>

<template>
    <AppItemCard
        :expanded="open"
        :disabled="!anyEnabled"
        :accent-bar="isSystem ? 'neutral' : 'accent'"
        @update:expanded="open = $event"
    >
        <template #leading>
            <span class="lead" :title="isSystem ? t('behaviors.card.systemRowLocked') : undefined" aria-hidden="true">
                <Icon
                    :icon="isSystem ? 'material-symbols:lock-outline' : 'material-symbols:bolt-outline-rounded'"
                    width="16" height="16"
                />
            </span>
        </template>

        <template #title>
            <span class="title">/{{ command.name }}</span>
            <span class="summary">{{ command.description }}</span>
        </template>

        <template #trailing>
            <AppBadge size="sm" tone="accent" variant="outline" icon="material-symbols:bolt-outline-rounded">
                {{ t('behaviors.card.triggerCommand') }}
            </AppBadge>
            <AppBadge v-if="!isRoot" size="sm">
                {{ t('behaviors.card.subcommandCount', { count: command.leaves.length }) }}
            </AppBadge>
            <AppBadge v-if="isSystem" size="sm" icon="material-symbols:settings-outline" :title="t('behaviors.card.tagSystem')">
                {{ t('behaviors.card.tagSystemShort') }}
            </AppBadge>
            <AppBadge v-if="unhealthy" size="sm" tone="danger" icon="material-symbols:heart-broken-rounded">
                {{ t('behaviors.card.unhealthy') }}
            </AppBadge>
            <AppToggle
                v-if="isRoot"
                :model-value="command.leaves[0].enabled"
                disabled
                :title="isSystem ? t('behaviors.card.toggleProtected') : t('behaviors.card.toggleReadOnly')"
                :aria-label="command.leaves[0].enabled ? t('behaviors.card.enabled') : t('behaviors.card.disabled')"
            />
        </template>

        <div class="body">
            <BehaviorSourceNotice v-if="isSystem" />
            <dl class="details">
                <dt>{{ t('behaviors.card.registration') }}</dt>
                <dd>{{ registration }}</dd>
                <dt>{{ t('behaviors.card.contexts') }}</dt>
                <dd>{{ command.contexts.map((c) => t(`behaviors.card.context.${c}`)).join('、') }}</dd>
                <dt>{{ t('behaviors.card.integrationTypes') }}</dt>
                <dd>{{ command.integrationTypes.map((i) => t(`behaviors.card.integration.${i}`)).join('、') }}</dd>
                <dt>{{ t('behaviors.card.defaultMemberPermissions') }}</dt>
                <dd>{{ command.defaultMemberPermissions ?? t('behaviors.card.permissionsNone') }}</dd>
            </dl>

            <ul class="leaves">
                <li v-for="leaf in command.leaves" :key="leaf.id" class="leaf">
                    <header class="leaf-head">
                        <code class="leaf-path">/{{ leafPath(leaf) }}</code>
                        <span class="leaf-title">{{ leaf.title }}</span>
                        <span class="spacer" />
                        <AppToggle
                            v-if="!isRoot"
                            size="sm"
                            :model-value="leaf.enabled"
                            disabled
                            :title="t('behaviors.card.toggleReadOnly')"
                            :aria-label="leaf.enabled ? t('behaviors.card.enabled') : t('behaviors.card.disabled')"
                        />
                    </header>
                    <p v-if="leaf.leafDescription && !isRoot" class="leaf-desc">{{ leaf.leafDescription }}</p>
                    <p v-if="leaf.options.length > 0" class="options">
                        {{ t('behaviors.card.options') }}:
                        <code v-for="o in leaf.options" :key="o.name" class="option">
                            {{ o.name }}{{ o.required ? '' : '?' }}: {{ o.type }}
                        </code>
                    </p>
                    <BehaviorActionDetails
                        :action-source="leaf.actionSource"
                        :webhook="leaf.webhook"
                        :stats="leaf.stats"
                    />
                </li>
            </ul>
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
    white-space: nowrap;
    flex-shrink: 0;
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
.details {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 0.35rem 0.75rem;
    margin: 0;
    font-size: 0.85rem;
}
dt { color: var(--text-muted); }
dd { margin: 0; overflow-wrap: anywhere; }
.leaves {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
}
.leaf {
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 0.5rem 0.65rem;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
}
.leaf-head { display: flex; align-items: center; gap: 0.5rem; }
.leaf-path { font-weight: 600; }
.leaf-title { color: var(--text-muted); font-size: 0.85rem; }
.spacer { flex: 1; }
.leaf-desc { margin: 0; font-size: 0.85rem; }
.options { margin: 0; font-size: 0.82rem; color: var(--text-muted); display: flex; flex-wrap: wrap; gap: 0.35rem; }
.option { color: var(--text); }
</style>

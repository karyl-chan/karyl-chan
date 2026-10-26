<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { Icon } from '@iconify/vue';
import { AppButton } from '@karyl-chan/ui';
import BehaviorCard from './BehaviorCard.vue';
import CommandCard from './CommandCard.vue';
import type { BehaviorSection } from '../../../api/behavior';
import type { SectionItems } from './behavior-sections';
import { sectionKind, sectionLabel } from './section-labels';

const { t } = useI18n();

const props = defineProps<{
    section: BehaviorSection;
    items: SectionItems | null;
    guildNames: ReadonlyMap<string, string>;
    loading?: boolean;
    error?: string | null;
}>();

const emit = defineEmits<{
    (e: 'retry'): void;
}>();

const isEmpty = computed(
    () =>
        !props.items ||
        (!props.items.system &&
            props.items.commands.length === 0 &&
            props.items.messageTriggers.length === 0)
);
</script>

<template>
    <section class="workspace">
        <header class="ws-head">
            <h2 class="title">{{ sectionLabel(t, section, guildNames) }}</h2>
            <span class="kind-badge">{{ sectionKind(t, section) }}</span>
        </header>

        <p class="notice">
            <Icon icon="material-symbols:visibility-outline-rounded" width="16" height="16" aria-hidden="true" />
            {{ t('behaviors.workspace.readOnly') }}
        </p>

        <div v-if="error" class="error" role="alert">
            <span>{{ t('behaviors.workspace.loadError', { error }) }}</span>
            <AppButton size="sm" variant="ghost" @click="emit('retry')">{{ t('common.refresh') }}</AppButton>
        </div>

        <p v-if="loading && isEmpty" class="muted center">{{ t('common.loading') }}</p>
        <p v-else-if="isEmpty && !error" class="muted center">{{ t('behaviors.workspace.empty') }}</p>

        <template v-if="items">
            <!-- 系統列釘在所屬分區最上方（ADR 0003） -->
            <div v-if="items.system" class="card-list">
                <CommandCard v-if="items.system.kind === 'command'" :command="items.system" />
                <BehaviorCard v-else :trigger="items.system" />
            </div>

            <template v-if="items.commands.length > 0">
                <h3 class="group-title">{{ t('behaviors.workspace.commands') }}</h3>
                <div class="card-list">
                    <CommandCard v-for="c in items.commands" :key="c.id" :command="c" />
                </div>
            </template>

            <template v-if="items.messageTriggers.length > 0">
                <h3 class="group-title">{{ t('behaviors.workspace.messageTriggers') }}</h3>
                <div class="card-list">
                    <BehaviorCard v-for="m in items.messageTriggers" :key="m.id" :trigger="m" />
                </div>
            </template>
        </template>
    </section>
</template>

<style scoped>
.workspace {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    padding: 0.75rem;
    overflow-y: auto;
}
.ws-head {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-shrink: 0;
}
.title { margin: 0; font-size: 1.05rem; color: var(--text-strong); }
.kind-badge {
    font-size: 0.72rem;
    padding: 0.12rem 0.45rem;
    border-radius: 999px;
    background: var(--bg-page);
    border: 1px solid var(--border);
    color: var(--text-muted);
}
.notice {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    margin: 0;
    font-size: 0.82rem;
    color: var(--text-muted);
}
.group-title {
    margin: 0.25rem 0 0;
    font-size: 0.78rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-muted);
}
.card-list { display: flex; flex-direction: column; gap: 0.5rem; }
.muted { color: var(--text-muted); }
.center { padding: 1rem; text-align: center; }
.error {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    color: var(--danger);
    font-size: 0.9rem;
}
</style>

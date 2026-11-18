<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import { Icon } from '@iconify/vue';
import type { BehaviorTargetKey, BehaviorTargetView } from '../../../api/behavior';
import { targetIcon, targetKind, targetLabel, type TargetNames } from './target-labels';

const { t } = useI18n();

const props = defineProps<{
    /** The Behavior Targets in the order the server lists them (ADR 0004): one flat list. */
    targets: readonly BehaviorTargetView[];
    counts: Record<string, number>;
    selected: BehaviorTargetKey | null;
    names: TargetNames;
    loading?: boolean;
}>();

const emit = defineEmits<{
    (e: 'select', key: BehaviorTargetKey): void;
    (e: 'create'): void;
}>();

/** The second line: what the built-in targets hold; for a created one, what kind it is. */
function sub(target: BehaviorTargetView): string {
    switch (target.kind) {
        case 'app':
            return t('behaviors.sidebar.appHint');
        case 'bot_dm':
            return t('behaviors.sidebar.botDmHint');
        case 'guild_all':
            return t('behaviors.sidebar.guildAllHint');
        case 'group':
            return t('behaviors.sidebar.groupSub', { count: target.memberCount ?? 0 });
        default:
            return targetKind(t, target);
    }
}

const label = (target: BehaviorTargetView) => targetLabel(t, target, props.names);
</script>

<template>
    <header class="sidebar-header">
        <span class="title">{{ t('behaviors.sidebar.title') }}</span>
        <button
            type="button"
            class="create"
            data-test="create-target"
            :title="t('behaviors.target.create.open')"
            :aria-label="t('behaviors.target.create.open')"
            @click="emit('create')"
        >
            <Icon icon="material-symbols:add-rounded" width="20" height="20" aria-hidden="true" />
        </button>
    </header>

    <div v-if="loading && targets.length === 0" class="loading muted">
        {{ t('common.loading') }}
    </div>

    <ul v-else class="tab-list">
        <li v-for="target in targets" :key="target.key">
            <button
                type="button"
                :class="['tab-row', { active: selected === target.key, pinned: target.builtin }]"
                :aria-current="selected === target.key ? 'page' : undefined"
                :data-test="`target-${target.key}`"
                @click="emit('select', target.key)"
            >
                <span :class="['avatar', target.builtin ? 'accent' : target.kind]" aria-hidden="true">
                    <Icon :icon="targetIcon(target)" width="18" height="18" />
                </span>
                <span class="meta">
                    <span class="name">{{ label(target) }}</span>
                    <span class="sub">{{ sub(target) }}</span>
                </span>
                <span v-if="counts[target.key]" class="count">{{ counts[target.key] }}</span>
            </button>
        </li>
    </ul>
</template>

<style scoped>
.sidebar-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.6rem 0.75rem;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
    height: 54px;
}
@media (max-width: 768px) {
    .sidebar-header { height: auto; }
}
.title {
    flex: 1;
    font-weight: 600;
    color: var(--text-strong);
}
.create {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 30px;
    height: 30px;
    border: none;
    border-radius: 50%;
    background: none;
    color: var(--text-muted);
    cursor: pointer;
}
.create:hover { color: var(--text); background: var(--bg-surface-hover); }

.tab-list {
    list-style: none;
    margin: 0;
    padding: 0;
}
.tab-row {
    display: flex;
    gap: 0.6rem;
    width: 100%;
    padding: 0.55rem 0.75rem;
    cursor: pointer;
    background: none;
    border: none;
    border-bottom: 1px solid var(--border);
    align-items: center;
    text-align: left;
    color: inherit;
    font: inherit;
}
.tab-row:hover { background: var(--bg-surface-hover); }
.tab-row.active { background: var(--bg-surface-active); }
.tab-row.pinned { background: var(--bg-surface-hover); }
.tab-row.pinned.active { background: var(--bg-surface-active); }
.avatar {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 36px;
    height: 36px;
    border-radius: 50%;
    flex-shrink: 0;
    background: var(--bg-page);
    color: var(--text-muted);
}
.avatar.accent {
    background: var(--accent-bg);
    color: var(--accent-text-strong);
}
.avatar.guild,
.avatar.channel {
    background: var(--success-bg, var(--accent-bg));
    color: var(--success-text, var(--accent-text-strong));
}
.meta {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
}
.name {
    font-weight: 500;
    color: var(--text-strong);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.sub {
    font-size: 0.78rem;
    color: var(--text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.count {
    font-size: 0.75rem;
    color: var(--text-muted);
}
.muted { color: var(--text-muted); font-size: 0.9rem; }
.loading { padding: 1rem; text-align: center; }
</style>

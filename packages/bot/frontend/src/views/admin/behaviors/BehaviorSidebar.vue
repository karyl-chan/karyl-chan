<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { Icon } from '@iconify/vue';
import type { BehaviorSection } from '../../../api/behavior';
import { parseSection } from './behavior-sections';
import { sectionIcon, sectionLabel } from './section-labels';

const { t } = useI18n();

const props = defineProps<{
    /** From sidebarSections(): app, bot_dm, guild:all, then guilds + channels. */
    sections: BehaviorSection[];
    counts: Record<string, number>;
    selected: BehaviorSection | null;
    guildNames: ReadonlyMap<string, string>;
    loading?: boolean;
}>();

const emit = defineEmits<{
    (e: 'select', section: BehaviorSection): void;
}>();

// 三個分區（ADR 0003）：App 指令、與 bot 的私訊、伺服器（全部伺服器 /
// 指定伺服器 / 指定頻道）。分區由觸發推導，這裡只照 key 分組。
const serverSections = computed(() =>
    props.sections.filter((s) => {
        const kind = parseSection(s).kind;
        return kind === 'guild_all' || kind === 'guild' || kind === 'channel';
    })
);

const guildOpen = ref(true);

function hint(section: BehaviorSection): string {
    const kind = parseSection(section).kind;
    if (kind === 'app') return t('behaviors.sidebar.appHint');
    if (kind === 'bot_dm') return t('behaviors.sidebar.botDmHint');
    if (kind === 'guild_all') return t('behaviors.sidebar.guildAllHint');
    return t('behaviors.sidebar.behaviorCount', { count: props.counts[section] ?? 0 });
}
</script>

<template>
    <header class="sidebar-header">
        <span class="title">{{ t('behaviors.sidebar.title') }}</span>
    </header>

    <div v-if="loading && sections.length === 0" class="loading muted">
        {{ t('common.loading') }}
    </div>

    <template v-else>
        <ul class="tab-list">
            <li v-for="section in (['app', 'bot_dm'] as const)" :key="section">
                <button
                    type="button"
                    :class="['tab-row', 'pinned', { active: selected === section }]"
                    :aria-current="selected === section ? 'page' : undefined"
                    @click="emit('select', section)"
                >
                    <span class="avatar avatar-fallback accent" aria-hidden="true">
                        <Icon :icon="sectionIcon(section)" width="18" height="18" />
                    </span>
                    <span class="meta">
                        <span class="name">{{ sectionLabel(t, section, guildNames) }}</span>
                        <span class="sub">{{ hint(section) }}</span>
                    </span>
                    <span v-if="counts[section]" class="count">{{ counts[section] }}</span>
                </button>
            </li>
        </ul>

        <button
            type="button"
            class="section-header"
            :aria-expanded="guildOpen"
            @click="guildOpen = !guildOpen"
        >
            <Icon
                :icon="guildOpen ? 'material-symbols:expand-more-rounded' : 'material-symbols:chevron-right-rounded'"
                width="18" height="18"
            />
            <span class="section-label">{{ t('behaviors.sidebar.guildSection') }}</span>
        </button>
        <ul v-show="guildOpen" class="tab-list">
            <li v-for="section in serverSections" :key="section">
                <button
                    type="button"
                    :class="[
                        'tab-row',
                        {
                            active: selected === section,
                            pinned: section === 'guild:all',
                            nested: parseSection(section).kind === 'channel',
                        },
                    ]"
                    :aria-current="selected === section ? 'page' : undefined"
                    @click="emit('select', section)"
                >
                    <span class="avatar avatar-fallback guild" aria-hidden="true">
                        <Icon :icon="sectionIcon(section)" width="18" height="18" />
                    </span>
                    <span class="meta">
                        <span class="name">{{ sectionLabel(t, section, guildNames) }}</span>
                        <span class="sub">{{ hint(section) }}</span>
                    </span>
                </button>
            </li>
        </ul>
    </template>
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
    font-weight: 600;
    color: var(--text-strong);
}

.section-header {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    width: 100%;
    padding: 0.45rem 0.75rem 0.2rem;
    background: none;
    border: none;
    cursor: pointer;
    user-select: none;
    color: var(--text-muted);
    text-align: left;
}
.section-header:hover { color: var(--text); }
.section-label {
    font-size: 0.72rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
}

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
.tab-row.nested { padding-left: 1.75rem; }
.avatar {
    width: 36px;
    height: 36px;
    border-radius: 50%;
    flex-shrink: 0;
}
.tab-row.nested .avatar { width: 28px; height: 28px; }
.avatar-fallback {
    display: flex;
    align-items: center;
    justify-content: center;
}
.avatar-fallback.accent {
    background: var(--accent-bg);
    color: var(--accent-text-strong);
}
.avatar-fallback.guild {
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

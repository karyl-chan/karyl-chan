<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Icon } from '@iconify/vue';
import Sortable from 'sortablejs';
import { AppButton, Spacer } from '@karyl-chan/ui';
import MessageTriggerCard from './MessageTriggerCard.vue';
import CommandCard from './CommandCard.vue';
import type { BehaviorSection, MessageTriggerView } from '../../../api/behavior';
import type { SectionItems } from './behavior-sections';
import { locationOfSection } from './message-trigger-location';
import { sectionKind, sectionLabel } from './section-labels';

const { t } = useI18n();

const props = defineProps<{
    section: BehaviorSection;
    items: SectionItems | null;
    guildNames: ReadonlyMap<string, string>;
    /** Audience Groups in use, sorted, and how many triggers use each. */
    groupNames: readonly string[];
    groupUse: ReadonlyMap<string, number>;
    /** The card to open (a trigger that just moved here or was created). */
    expandId: number | null;
    loading?: boolean;
    error?: string | null;
}>();

const emit = defineEmits<{
    (e: 'retry'): void;
    (e: 'reload'): void;
    (e: 'updated', trigger: MessageTriggerView): void;
    (e: 'deleted', id: number): void;
    (e: 'add'): void;
    /** A new order for this section's message triggers (its Message Trigger Location). */
    (e: 'reorder', ids: number[]): void;
}>();

const isEmpty = computed(
    () =>
        !props.items ||
        (!props.items.system &&
            props.items.commands.length === 0 &&
            props.items.messageTriggers.length === 0)
);

// ── reorder (#121): drag the handle, or Alt+↑/↓ on it ──────────────────────
// Only this location's custom triggers move; the system row is pinned
// above them, outside the sortable list.

function move(from: number, to: number) {
    const ids = (props.items?.messageTriggers ?? []).map((m) => m.id);
    if (to < 0 || to >= ids.length || from === to) return;
    const [moved] = ids.splice(from, 1);
    ids.splice(to, 0, moved);
    emit('reorder', ids);
}

const listRef = ref<HTMLElement | null>(null);
let sortable: Sortable | null = null;
watch(
    listRef,
    (el) => {
        sortable?.destroy();
        sortable = el
            ? Sortable.create(el, {
                  handle: '.drag-handle',
                  animation: 150,
                  ghostClass: 'sortable-ghost',
                  onEnd: ({ oldIndex, newIndex, item, from }) => {
                      if (oldIndex == null || newIndex == null || oldIndex === newIndex) return;
                      // put the node back: Vue re-renders the list in the new order
                      from.removeChild(item);
                      from.insertBefore(item, from.children[oldIndex] ?? null);
                      move(oldIndex, newIndex);
                  },
              })
            : null;
    },
    { flush: 'post' }
);
onBeforeUnmount(() => sortable?.destroy());

/** What this section can and cannot hold, in Discord's terms (board 1). */
const note = computed(() => {
    const kind = locationOfSection(props.section)?.kind;
    if (kind === 'guild') return t('behaviors.workspace.note.guild');
    if (kind === 'channel') return t('behaviors.workspace.note.channel');
    return '';
});
</script>

<template>
    <section class="workspace">
        <header class="ws-head">
            <h2 class="title">{{ sectionLabel(t, section, guildNames) }}</h2>
            <span class="kind-badge">{{ sectionKind(t, section) }}</span>
            <Spacer />
            <AppButton size="sm" icon="material-symbols:add-rounded" data-test="add-behavior" @click="emit('add')">
                {{ t('behaviors.add.open') }}
            </AppButton>
        </header>

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
                <MessageTriggerCard
                    v-else
                    :trigger="items.system"
                    :guild-names="guildNames"
                    :group-names="groupNames"
                    :group-use="groupUse"
                />
            </div>

            <template v-if="items.commands.length > 0">
                <h3 class="group-title">{{ t('behaviors.workspace.commands') }}</h3>
                <div class="card-list">
                    <CommandCard v-for="c in items.commands" :key="c.id" :command="c" />
                </div>
            </template>

            <template v-if="items.messageTriggers.length > 0">
                <h3 class="group-title">{{ t('behaviors.workspace.messageTriggers') }}</h3>
                <div ref="listRef" class="card-list">
                    <MessageTriggerCard
                        v-for="(m, index) in items.messageTriggers"
                        :key="m.id"
                        :trigger="m"
                        :expand="expandId === m.id"
                        :guild-names="guildNames"
                        :group-names="groupNames"
                        :group-use="groupUse"
                        @updated="emit('updated', $event)"
                        @deleted="emit('deleted', $event)"
                        @reload="emit('reload')"
                    >
                        <template #handle>
                            <button
                                type="button"
                                class="drag-handle"
                                :aria-label="t('behaviors.workspace.reorderHandle', { title: m.title })"
                                :title="t('behaviors.workspace.reorderHint')"
                                @keydown.alt.up.prevent="move(index, index - 1)"
                                @keydown.alt.down.prevent="move(index, index + 1)"
                            >
                                <Icon icon="material-symbols:drag-indicator" width="16" height="16" aria-hidden="true" />
                            </button>
                        </template>
                    </MessageTriggerCard>
                </div>
            </template>
        </template>

        <p v-if="note" class="note">{{ note }}</p>
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
    flex-wrap: wrap;
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
.group-title {
    margin: 0.25rem 0 0;
    font-size: 0.78rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-muted);
}
.card-list { display: flex; flex-direction: column; gap: 0.5rem; }
.drag-handle {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 28px;
    padding: 0;
    border: none;
    background: none;
    color: var(--text-muted);
    cursor: grab;
}
.drag-handle:hover { color: var(--text); }
.card-list :deep(.sortable-ghost) { opacity: 0.4; }
.muted { color: var(--text-muted); }
.center { padding: 1rem; text-align: center; }
.note { margin: 0.25rem 0 0; font-size: 0.78rem; line-height: 1.6; color: var(--text-muted); }
.error {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    color: var(--danger);
    font-size: 0.9rem;
}
</style>

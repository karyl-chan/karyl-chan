<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Icon } from '@iconify/vue';
import Sortable from 'sortablejs';
import { AppButton } from '@karyl-chan/ui';
import MessageTriggerCard from './MessageTriggerCard.vue';
import CommandCard from './CommandCard.vue';
import SystemLoginCard from './SystemLoginCard.vue';
import ServiceBehaviorCard from './ServiceBehaviorCard.vue';
import TargetHeader from './TargetHeader.vue';
import type {
    BehaviorItemView,
    BehaviorTargetView,
    CommandView,
    MessageTriggerView,
    ServiceBehaviorView,
} from '../../../api/behavior';
import { itemKey } from './behavior-sections';
import { countInTargetItems, type TargetItems } from './behavior-targets';

const { t } = useI18n();

const props = defineProps<{
    /** The Behavior Target on show (ADR 0004). */
    target: BehaviorTargetView;
    /** Its name, as the sidebar shows it. */
    label: string;
    items: TargetItems | null;
    guildNames: ReadonlyMap<string, string>;
    /** Audience Groups in use, sorted, and how many triggers use each. */
    groupNames: readonly string[];
    groupUse: ReadonlyMap<string, number>;
    /** Every command on the page, whatever its target: a trigger conversion may join one. */
    commands: readonly CommandView[];
    /** The card to open (an item that just moved here or was created), by itemKey. */
    expandKey: string | null;
    loading?: boolean;
    error?: string | null;
}>();

const emit = defineEmits<{
    (e: 'retry'): void;
    (e: 'reload'): void;
    (e: 'updated', trigger: MessageTriggerView): void;
    (e: 'commandUpdated', command: CommandView): void;
    /** The login's trigger changed (or its command was resynced). */
    (e: 'systemUpdated', system: BehaviorItemView): void;
    /** A Service Behavior's trigger was saved (#126). */
    (e: 'serviceUpdated', behavior: ServiceBehaviorView): void;
    (e: 'deleted', id: number): void;
    /** A behavior changed its kind of trigger (#172): it is listed elsewhere now. */
    (e: 'converted', item: BehaviorItemView): void;
    (e: 'add'): void;
    /** A new order for this target's message triggers. */
    (e: 'reorder', ids: number[]): void;
    /** The target was deleted. */
    (e: 'targetDeleted', target: BehaviorTargetView): void;
    /** The target is a group and its member count changed. */
    (e: 'members', count: number): void;
}>();

const isEmpty = computed(
    () =>
        !props.items ||
        (!props.items.system &&
            props.items.services.length === 0 &&
            props.items.commands.length === 0 &&
            props.items.messageTriggers.length === 0)
);

// ── reorder (#121): drag the handle, or Alt+↑/↓ on it ──────────────────────
// Only this target's custom triggers move; the system row is pinned
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

/** What this target can and cannot hold, in Discord's terms (board 1). */
const note = computed(() => {
    if (props.target.kind === 'guild') return t('behaviors.workspace.note.guild');
    if (props.target.kind === 'channel') return t('behaviors.workspace.note.channel');
    return '';
});

const count = computed(() => (props.items ? countInTargetItems(props.items) : 0));
</script>

<template>
    <section class="workspace">
        <TargetHeader
            :target="target"
            :label="label"
            :count="count"
            @add="emit('add')"
            @deleted="emit('targetDeleted', $event)"
            @members="emit('members', $event)"
        />

        <div v-if="error" class="error" role="alert">
            <span>{{ t('behaviors.workspace.loadError', { error }) }}</span>
            <AppButton size="sm" variant="ghost" @click="emit('retry')">{{ t('common.refresh') }}</AppButton>
        </div>

        <p v-if="loading && isEmpty" class="muted center">{{ t('common.loading') }}</p>
        <p v-else-if="isEmpty && !error" class="muted center">{{ t('behaviors.workspace.empty') }}</p>

        <template v-if="items">
            <!-- 系統列釘在所屬對象最上方（ADR 0003） -->
            <div v-if="items.system" class="card-list">
                <SystemLoginCard
                    :system="items.system"
                    :expand="expandKey === itemKey(items.system)"
                    :guild-names="guildNames"
                    @updated="emit('systemUpdated', $event)"
                    @reload="emit('reload')"
                />
            </div>

            <!-- 服務列（#126）：鎖定，只換觸發；訊息觸發比對在登入之前 -->
            <template v-if="items.services.length > 0">
                <h3 class="group-title">{{ t('behaviors.workspace.services') }}</h3>
                <div class="card-list" data-test="service-behaviors">
                    <ServiceBehaviorCard
                        v-for="s in items.services"
                        :key="s.service.id"
                        :behavior="s"
                        :expand="expandKey === itemKey(s)"
                        :guild-names="guildNames"
                        :group-names="groupNames"
                        :group-use="groupUse"
                        @updated="emit('serviceUpdated', $event)"
                        @reload="emit('reload')"
                    />
                </div>
            </template>

            <template v-if="items.commands.length > 0">
                <h3 class="group-title">{{ t('behaviors.workspace.commands') }}</h3>
                <div class="card-list">
                    <CommandCard
                        v-for="c in items.commands"
                        :key="c.id"
                        :command="c"
                        :expand="expandKey === itemKey(c)"
                        :guild-names="guildNames"
                        :group-names="groupNames"
                        @updated="emit('commandUpdated', $event)"
                        @reload="emit('reload')"
                        @deleted="emit('reload')"
                        @converted="emit('converted', $event)"
                    />
                </div>
            </template>

            <template v-if="items.messageTriggers.length > 0">
                <h3 class="group-title">{{ t('behaviors.workspace.messageTriggers') }}</h3>
                <div ref="listRef" class="card-list">
                    <MessageTriggerCard
                        v-for="(m, index) in items.messageTriggers"
                        :key="m.id"
                        :trigger="m"
                        :expand="expandKey === itemKey(m)"
                        :guild-names="guildNames"
                        :group-names="groupNames"
                        :group-use="groupUse"
                        :commands="commands"
                        @updated="emit('updated', $event)"
                        @deleted="emit('deleted', $event)"
                        @reload="emit('reload')"
                        @converted="emit('converted', $event)"
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

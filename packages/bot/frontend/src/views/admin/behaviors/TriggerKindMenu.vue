<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import { Icon } from '@iconify/vue';
import { AppBadge, AppMenu, AppMenuItem } from '@karyl-chan/ui';

/**
 * The trigger-kind tag in a card's title row (訊息 / 指令), and the way to
 * convert the behavior to the other kind (#172): a menu with both kinds,
 * the current one disabled. Choosing the other one only asks the card to
 * open its conversion dialog — nothing changes before that is confirmed.
 * `blocked` disables the other kind too and says why (the system login
 * for an admin who is not the owner).
 */
type Kind = 'message' | 'command';

defineProps<{
    kind: Kind;
    blocked?: string | null;
}>();

const emit = defineEmits<{ (e: 'convert', kind: Kind): void }>();

const { t } = useI18n();

const KINDS: readonly Kind[] = ['message', 'command'];
const ICONS: Record<Kind, string> = {
    message: 'material-symbols:article-outline',
    command: 'material-symbols:bolt-outline-rounded',
};
const LABELS: Record<Kind, string> = {
    message: 'behaviors.card.triggerMessage',
    command: 'behaviors.card.triggerCommand',
};
</script>

<template>
    <AppMenu placement="bottom-end" :offset="[0, 6]" :drawer-title="t('behaviors.convertTrigger.menuTitle')">
        <template #trigger>
            <button
                type="button"
                class="kind-tag"
                data-test="trigger-kind"
                :aria-label="t('behaviors.convertTrigger.menuLabel', { kind: t(LABELS[kind]) })"
                :title="t('behaviors.convertTrigger.menuTitle')"
                aria-haspopup="menu"
            >
                <AppBadge
                    size="sm"
                    :tone="kind === 'command' ? 'accent' : 'neutral'"
                    :variant="kind === 'command' ? 'outline' : 'soft'"
                    :icon="ICONS[kind]"
                >
                    {{ t(LABELS[kind]) }}
                    <Icon icon="material-symbols:expand-more-rounded" class="chevron" aria-hidden="true" />
                </AppBadge>
            </button>
        </template>
        <AppMenuItem
            v-for="k in KINDS"
            :key="k"
            :data-test="`convert-to-${k}`"
            :disabled="k === kind || !!blocked"
            :title="k !== kind && blocked ? blocked : undefined"
            @click="k !== kind && !blocked && emit('convert', k)"
        >
            <Icon :icon="ICONS[k]" width="16" height="16" />
            <span class="item">
                <span>{{ t(LABELS[k]) }}</span>
                <span v-if="k === kind" class="sub">{{ t('behaviors.convertTrigger.current') }}</span>
                <span v-else-if="blocked" class="sub" data-test="convert-blocked">{{ blocked }}</span>
            </span>
        </AppMenuItem>
    </AppMenu>
</template>

<style scoped>
.kind-tag {
    display: inline-flex;
    align-items: center;
    padding: 0;
    border: none;
    background: none;
    border-radius: var(--radius-pill);
    cursor: pointer;
    font: inherit;
}
.kind-tag:hover :deep(.app-badge) { filter: brightness(0.95); }
.kind-tag:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.chevron { font-size: 0.9em; margin-left: -0.05rem; }
.item { display: flex; flex-direction: column; gap: 0.1rem; }
.sub { font-size: 0.75rem; color: var(--text-muted); }
</style>

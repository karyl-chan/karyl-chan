<script setup lang="ts">
/**
 * UserItem — compact user row (avatar + primary + secondary text +
 * optional trailing content).
 *
 * Pure presentation: caller passes the data and handles `@click`
 * themselves. Avatar defaults to hover-animation (Discord DM-list
 * convention); pass `avatar-animate="always"` or `"never"` to override.
 *
 * Use the `#trailing` slot for timestamps, unread pills, action
 * buttons, or anything that should sit on the right edge of the row.
 * `#sub` overrides the default subtitle slot rendering when you want
 * richer secondary content (chips, status icons, …).
 */
import { computed } from 'vue';
import UserAvatar from './UserAvatar.vue';

const props = withDefaults(defineProps<{
    userId?: string;
    avatarUrl?: string | null;
    name: string;
    /** Optional secondary line (username, status, last message preview, …). */
    subtitle?: string | null;
    /** Renders a 'BOT' tag next to the name. */
    isBot?: boolean;
    /** Avatar pixel size. Default 40. */
    avatarSize?: number;
    /** When to animate the avatar (default `hover`). */
    avatarAnimate?: 'never' | 'hover' | 'always';
    /** Whether the row is currently selected (e.g. active conversation). */
    active?: boolean;
    /** Disables interactions + dims the row. */
    disabled?: boolean;
    /** Tag elements as `<button>` for keyboard navigation. Default `<div>`. */
    interactive?: boolean;
}>(), {
    userId: undefined,
    avatarUrl: null,
    subtitle: null,
    isBot: false,
    avatarSize: 40,
    avatarAnimate: 'hover',
    active: false,
    disabled: false,
    interactive: false,
});

defineEmits<{
    (e: 'click'): void;
}>();

defineSlots<{
    sub?: (props: Record<string, never>) => unknown;
    trailing?: (props: Record<string, never>) => unknown;
}>();

const tag = computed(() => (props.interactive ? 'button' : 'div'));
</script>

<template>
    <component
        :is="tag"
        :class="['user-item', { active, disabled, interactive }]"
        :type="interactive ? 'button' : undefined"
        :disabled="interactive && disabled ? true : undefined"
        @click="!disabled && $emit('click')"
    >
        <UserAvatar
            :src="avatarUrl"
            :name="name"
            :size="avatarSize"
            :animate="avatarAnimate"
        />
        <div class="text">
            <div class="row">
                <span class="name">{{ name }}</span>
                <span v-if="isBot" class="bot-tag">BOT</span>
            </div>
            <div v-if="$slots.sub || subtitle" class="sub">
                <slot name="sub">{{ subtitle }}</slot>
            </div>
        </div>
        <div v-if="$slots.trailing" class="trailing">
            <slot name="trailing" />
        </div>
    </component>
</template>

<style scoped>
.user-item {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    padding: 0.45rem 0.7rem;
    border-radius: var(--radius-base);
    background: transparent;
    color: var(--text);
    width: 100%;
    text-align: left;
    /* button-tag defaults reset */
    border: none;
    font: inherit;
}
.user-item.interactive {
    cursor: pointer;
}
.user-item.interactive:hover:not(.disabled) {
    background: var(--bg-surface-hover);
}
.user-item.active {
    background: var(--bg-surface-active);
}
.user-item.disabled {
    opacity: 0.55;
    cursor: not-allowed;
}

.text {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 0.05rem;
}
.row {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    min-width: 0;
}
.name {
    font-weight: 500;
    font-size: 0.92rem;
    color: var(--text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
}
.bot-tag {
    background: var(--accent);
    color: var(--text-on-accent);
    font-size: 0.6rem;
    font-weight: 700;
    padding: 1px 5px;
    border-radius: 3px;
    line-height: 1.2;
    flex-shrink: 0;
}
.sub {
    color: var(--text-muted);
    font-size: 0.78rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
}

.trailing {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 0.4rem;
    color: var(--text-muted);
    font-size: 0.78rem;
}
</style>

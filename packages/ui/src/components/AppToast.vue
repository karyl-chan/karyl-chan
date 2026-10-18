<script setup lang="ts">
import { Icon } from '@iconify/vue';
import { useToastStore, type ToastItem } from '../stores/toastStore';

/**
 * Toast host — mount once near the app root. Renders `useToastStore()`
 * items bottom-right.
 *
 * - `error` / `warn` toasts are `role="alert"` (assertive); `info` /
 *   `success` are `role="status"` + `aria-live="polite"`.
 * - Timed toasts dismiss on click (as before); sticky toasts
 *   (`duration: 0`) only via their close button, so a stray click
 *   doesn't throw away a message the user is meant to act on.
 */
withDefaults(defineProps<{
    /** Accessible label of a sticky toast's close button. */
    closeLabel?: string;
}>(), {
    closeLabel: 'Dismiss'
});

const toast = useToastStore();

function isSticky(item: ToastItem) {
    return item.duration === 0;
}
function isAssertive(item: ToastItem) {
    return item.type === 'error' || item.type === 'warn';
}
function onItemClick(item: ToastItem) {
    if (!isSticky(item)) toast.dismiss(item.id);
}
</script>

<template>
    <Teleport to="body">
        <TransitionGroup name="toast" tag="div" class="toast-container">
            <div
                v-for="item in toast.items"
                :key="item.id"
                class="toast-item"
                :class="[`toast-item--${item.type}`, { 'toast-item--sticky': isSticky(item) }]"
                :role="isAssertive(item) ? 'alert' : 'status'"
                :aria-live="isAssertive(item) ? undefined : 'polite'"
                @click="onItemClick(item)"
            >
                <span class="toast-message">{{ item.message }}</span>
                <button
                    v-if="isSticky(item)"
                    type="button"
                    class="toast-close"
                    :aria-label="closeLabel"
                    @click.stop="toast.dismiss(item.id)"
                >
                    <Icon icon="material-symbols:close-rounded" width="16" height="16" />
                </button>
            </div>
        </TransitionGroup>
    </Teleport>
</template>

<style scoped>
.toast-container {
    position: fixed;
    bottom: 1rem;
    right: 1rem;
    z-index: 9999;
    display: flex;
    flex-direction: column-reverse;
    gap: 0.5rem;
    pointer-events: none;
}
.toast-item {
    pointer-events: auto;
    cursor: pointer;
    max-width: 360px;
    padding: 0.6rem 0.9rem;
    border-radius: var(--radius-sm, 6px);
    font-size: 0.82rem;
    line-height: 1.4;
    box-shadow: 0 4px 14px rgba(0, 0, 0, 0.25);
    display: flex;
    align-items: flex-start;
    gap: 0.5rem;
}
.toast-item--sticky {
    cursor: default;
    padding-right: 0.35rem;
}
.toast-message {
    flex: 1;
    min-width: 0;
    overflow-wrap: anywhere;
}
.toast-close {
    flex-shrink: 0;
    background: none;
    border: none;
    color: inherit;
    opacity: 0.75;
    cursor: pointer;
    padding: 0.1rem;
    margin: -0.1rem 0;
    border-radius: var(--radius-sm, 4px);
    display: inline-flex;
    align-items: center;
    justify-content: center;
}
.toast-close:hover { opacity: 1; }
.toast-item--error {
    background: var(--danger, #ef4444);
    color: #fff;
}
.toast-item--info {
    background: var(--bg-surface, #1e1e2e);
    color: var(--text, #cdd6f4);
    border: 1px solid var(--border, #45475a);
}
.toast-item--success {
    background: var(--success-bg, #d1fae5);
    color: var(--success-text, #065f46);
    border: 1px solid var(--border, #45475a);
}
.toast-item--warn {
    background: var(--warn-bg, #fef3c7);
    color: var(--warn-text, #92400e);
    border: 1px solid var(--border, #45475a);
}
.toast-enter-active,
.toast-leave-active {
    transition: all 0.25s ease;
}
.toast-enter-from {
    opacity: 0;
    transform: translateY(0.5rem);
}
.toast-leave-to {
    opacity: 0;
    transform: translateX(1rem);
}
@media (prefers-reduced-motion: reduce) {
    .toast-enter-active,
    .toast-leave-active {
        transition: opacity 0.15s ease;
    }
    .toast-enter-from,
    .toast-leave-to {
        transform: none;
    }
}
</style>

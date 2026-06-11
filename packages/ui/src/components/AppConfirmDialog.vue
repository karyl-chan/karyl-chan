<script setup lang="ts">
/**
 * AppConfirmDialog — generic confirmation dialog wrapping AppModal.
 *
 * `closeOnBackdrop` / `closeOnEscape` are automatically disabled when
 * `loading` is true to prevent accidental dismissal during async work.
 *
 * Labels (`confirmLabel`, `cancelLabel`, `loadingLabel`) are passed in
 * as props with English defaults — this component does not depend on
 * vue-i18n. Consumers that need translation pass localized strings.
 */
import { Icon } from '@iconify/vue';
import AppModal from './AppModal.vue';

withDefaults(defineProps<{
    visible: boolean;
    title: string;
    message: string;
    confirmLabel: string;
    /** Button colour: 'danger' = red, 'primary' = accent (default). */
    confirmVariant?: 'primary' | 'danger';
    loading?: boolean;
    /** Error message shown in a red box below the message. */
    error?: string;
    /** Extra status line, e.g. "Progress: 3 / 10" for batch operations. */
    progress?: string;
    /** Cancel button label. */
    cancelLabel?: string;
    /** Label shown on the primary button while `loading`. */
    loadingLabel?: string;
}>(), {
    confirmVariant: 'primary',
    loading: false,
    error: undefined,
    progress: undefined,
    cancelLabel: 'Cancel',
    loadingLabel: 'Loading…',
});

const emit = defineEmits<{
    (e: 'close'): void;
    (e: 'confirm'): void;
}>();
</script>

<template>
    <AppModal
        :visible="visible"
        :title="title"
        :close-on-backdrop="!loading"
        :close-on-escape="!loading"
        @close="emit('close')"
    >
        <div class="acd-body">
            <p class="acd-message">{{ message }}</p>
            <p v-if="progress" class="acd-progress">{{ progress }}</p>
            <pre v-if="error" class="acd-error" role="alert">{{ error }}</pre>
            <div class="acd-actions">
                <button
                    type="button"
                    class="acd-btn acd-btn--ghost"
                    :disabled="loading"
                    @click="emit('close')"
                >
                    {{ cancelLabel }}
                </button>
                <button
                    type="button"
                    :class="['acd-btn', confirmVariant === 'danger' ? 'acd-btn--danger' : 'acd-btn--primary']"
                    :disabled="loading"
                    @click="emit('confirm')"
                >
                    <Icon
                        v-if="loading"
                        icon="material-symbols:progress-activity"
                        width="14"
                        height="14"
                        class="acd-spin"
                    />
                    {{ loading ? loadingLabel : confirmLabel }}
                </button>
            </div>
        </div>
    </AppModal>
</template>

<style scoped>
/* Inner wrapper: flex-column layout + gap. Padding comes from
   AppModal's body default. */
.acd-body {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
}

.acd-message {
    margin: 0;
    color: var(--text);
    font-size: 0.9rem;
    line-height: 1.5;
}

.acd-progress {
    margin: 0;
    color: var(--text-muted);
    font-size: 0.85rem;
}

.acd-error {
    margin: 0;
    white-space: pre-wrap;
    background: color-mix(in srgb, var(--danger, #dc2626) 8%, transparent);
    border: 1px solid color-mix(in srgb, var(--danger, #dc2626) 30%, transparent);
    border-radius: var(--radius-base);
    padding: 0.5rem;
    font-size: 0.78rem;
    color: var(--danger, #dc2626);
    max-height: 12rem;
    overflow: auto;
}

.acd-actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
    padding-top: 0.25rem;
    border-top: 1px solid var(--border);
}

.acd-btn {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    padding: 0.4rem 0.85rem;
    border-radius: var(--radius-sm);
    font-size: 0.85rem;
    font-weight: 500;
    cursor: pointer;
}
.acd-btn:disabled {
    opacity: 0.55;
    cursor: not-allowed;
}

.acd-btn--ghost {
    background: none;
    border: 1px solid var(--border);
    color: var(--text);
}
.acd-btn--ghost:not(:disabled):hover {
    background: var(--bg-surface-hover);
}

.acd-btn--primary {
    background: var(--accent);
    color: var(--text-on-accent);
    border: none;
}
.acd-btn--primary:not(:disabled):hover {
    filter: brightness(1.1);
}

.acd-btn--danger {
    background: var(--danger, #dc2626);
    color: #fff;
    border: none;
}
.acd-btn--danger:not(:disabled):hover {
    filter: brightness(1.1);
}

@keyframes spin { to { transform: rotate(360deg); } }
.acd-spin { animation: spin 0.8s linear infinite; }
</style>

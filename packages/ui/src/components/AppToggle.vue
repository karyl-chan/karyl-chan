<script setup lang="ts">
import { computed } from 'vue';

/**
 * Standalone on/off switch. Replaces the per-page hand-rolled toggles
 * that previously lived inside BehaviorCard / PluginCard / etc., all
 * of which had byte-identical CSS for the 32×18 pill + 14px knob.
 *
 * Two sizes: `md` (32×18, the default — matches every existing call
 * site) and `sm` (26×15) for denser rows.
 *
 * `ariaLabel` is required by convention: the toggle has no visible
 * text, so a programmatic name is the only signal screen readers get.
 * Pass an empty string if the toggle is paired with a `<label>` that
 * already names it (rare — most call sites do not).
 */

const props = withDefaults(defineProps<{
    modelValue: boolean;
    disabled?: boolean;
    size?: 'sm' | 'md';
    ariaLabel?: string;
    /** Tooltip text. Caller typically derives this from the current state. */
    title?: string;
}>(), {
    disabled: false,
    size: 'md',
    ariaLabel: '',
    title: ''
});

const emit = defineEmits<{
    (e: 'update:modelValue', value: boolean): void;
}>();

const classes = computed(() => ({
    'app-toggle': true,
    [`app-toggle--${props.size}`]: true,
    'app-toggle--on': props.modelValue
}));

function onClick(): void {
    if (props.disabled) return;
    emit('update:modelValue', !props.modelValue);
}
</script>

<template>
    <button
        type="button"
        role="switch"
        :class="classes"
        :aria-checked="modelValue ? 'true' : 'false'"
        :aria-label="ariaLabel || undefined"
        :title="title || undefined"
        :disabled="disabled"
        @click.stop="onClick"
    >
        <span class="app-toggle__slider" aria-hidden="true"></span>
    </button>
</template>

<style scoped>
.app-toggle {
    position: relative;
    flex-shrink: 0;
    cursor: pointer;
    border: none;
    padding: 0;
    background: none;
}
.app-toggle:disabled { cursor: not-allowed; opacity: 0.6; }

.app-toggle--md { width: 32px; height: 18px; }
.app-toggle--sm { width: 26px; height: 15px; }

.app-toggle__slider {
    position: absolute;
    inset: 0;
    background: var(--border-strong);
    border-radius: 999px;
    transition: background var(--transition-base, 0.15s);
}
.app-toggle__slider::before {
    content: '';
    position: absolute;
    top: 2px;
    left: 2px;
    background: var(--bg-surface);
    border-radius: 50%;
    transition: transform var(--transition-base, 0.15s);
}
.app-toggle--md .app-toggle__slider::before { width: 14px; height: 14px; }
.app-toggle--sm .app-toggle__slider::before { width: 11px; height: 11px; }

.app-toggle--on .app-toggle__slider { background: var(--accent); }
.app-toggle--md.app-toggle--on .app-toggle__slider::before { transform: translateX(14px); }
.app-toggle--sm.app-toggle--on .app-toggle__slider::before { transform: translateX(11px); }

.app-toggle:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
    border-radius: 999px;
}
</style>

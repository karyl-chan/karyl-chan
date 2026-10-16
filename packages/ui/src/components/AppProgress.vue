<script setup lang="ts">
import { computed } from 'vue';

/**
 * Linear progress bar.
 *
 * - `value` 0–100 → determinate: `role="progressbar"` with
 *   `aria-valuenow` / `aria-valuemin` / `aria-valuemax`. Out-of-range
 *   values are clamped; non-finite values count as indeterminate.
 * - `value` omitted → indeterminate: a sliding bar, no aria-value*
 *   attributes. Under `prefers-reduced-motion: reduce` the bar stops
 *   moving and renders as a static dimmed fill instead.
 *
 * `label` is the accessible name (aria-label). To label it by visible
 * text instead, pass `aria-labelledby` — attrs fall through to the root.
 * `tone` follows AppBadge's semantic palette; `size` is the track height
 * (sm 4px, md 8px).
 */

export type ProgressTone = 'accent' | 'success' | 'warn' | 'danger';
export type ProgressSize = 'sm' | 'md';

const props = withDefaults(defineProps<{
    /** 0–100. Omit (undefined) for an indeterminate bar. */
    value?: number;
    /** Accessible name of the progress bar. */
    label?: string;
    size?: ProgressSize;
    tone?: ProgressTone;
}>(), {
    value: undefined,
    label: undefined,
    size: 'md',
    tone: 'accent'
});

const determinate = computed(() =>
    typeof props.value === 'number' && Number.isFinite(props.value)
);
const clamped = computed(() =>
    determinate.value ? Math.min(100, Math.max(0, props.value as number)) : 0
);
const classes = computed(() => [
    'app-progress',
    `app-progress--${props.size}`,
    `app-progress--tone-${props.tone}`,
    { 'app-progress--indeterminate': !determinate.value }
]);
</script>

<template>
    <div
        :class="classes"
        role="progressbar"
        :aria-label="label || undefined"
        :aria-valuenow="determinate ? clamped : undefined"
        :aria-valuemin="determinate ? 0 : undefined"
        :aria-valuemax="determinate ? 100 : undefined"
    >
        <div
            class="app-progress__bar"
            :style="determinate ? { width: `${clamped}%` } : undefined"
        />
    </div>
</template>

<style scoped>
.app-progress {
    --app-progress-fill: var(--accent);
    position: relative;
    width: 100%;
    overflow: hidden;
    border-radius: var(--radius-pill, 999px);
    background: var(--bg-surface-2);
    box-shadow: inset 0 0 0 1px var(--border);
}
.app-progress--sm { height: 4px; }
.app-progress--md { height: 8px; }

.app-progress--tone-accent { --app-progress-fill: var(--accent); }
.app-progress--tone-success { --app-progress-fill: var(--success-text); }
.app-progress--tone-warn { --app-progress-fill: var(--warn-text); }
.app-progress--tone-danger { --app-progress-fill: var(--danger); }

.app-progress__bar {
    height: 100%;
    border-radius: inherit;
    background: var(--app-progress-fill);
    transition: width var(--transition-slow, 0.2s) ease;
}

.app-progress--indeterminate .app-progress__bar {
    position: absolute;
    top: 0;
    left: 0;
    width: 40%;
    animation: app-progress-slide 1.2s ease-in-out infinite;
}

@keyframes app-progress-slide {
    from { transform: translateX(-100%); }
    to { transform: translateX(250%); }
}

@media (prefers-reduced-motion: reduce) {
    .app-progress__bar { transition: none; }
    .app-progress--indeterminate .app-progress__bar {
        animation: none;
        width: 100%;
        opacity: 0.45;
    }
}
</style>

<script setup lang="ts">
import { computed } from 'vue';
import { Icon } from '@iconify/vue';

/**
 * Compact inline label. Replaces the per-page .tag / .status-pill /
 * .health-badge / .scope-chip / .stat classes that each carried their
 * own colour-by-state logic.
 *
 * Two axes:
 *   - `tone` is semantic colour: neutral (default), accent, success,
 *     warn, danger.
 *   - `variant` is style strength: soft (subtle background, default),
 *     outline (border-only, transparent background), solid (filled).
 *
 * `size` is the visual weight only — md by default, sm for the tighter
 * tag-row use case the bot's BehaviorCard trigger badges relied on.
 */

export type BadgeTone = 'neutral' | 'accent' | 'success' | 'warn' | 'danger';
export type BadgeVariant = 'soft' | 'outline' | 'solid';
export type BadgeSize = 'sm' | 'md';

const props = withDefaults(defineProps<{
    tone?: BadgeTone;
    variant?: BadgeVariant;
    size?: BadgeSize;
    /** Iconify icon shown before the label. */
    icon?: string;
    /** Render in monospaced font (e.g. for IDs / keys). */
    mono?: boolean;
}>(), {
    tone: 'neutral',
    variant: 'soft',
    size: 'md',
    icon: '',
    mono: false
});

const classes = computed(() => [
    'app-badge',
    `app-badge--${props.variant}`,
    `app-badge--tone-${props.tone}`,
    `app-badge--${props.size}`,
    { 'app-badge--mono': props.mono }
]);

const iconPx = computed(() => (props.size === 'sm' ? 11 : 13));
</script>

<template>
    <span :class="classes">
        <Icon v-if="icon" :icon="icon" :width="iconPx" :height="iconPx" class="app-badge__icon" />
        <slot />
    </span>
</template>

<style scoped>
.app-badge {
    display: inline-flex;
    align-items: center;
    gap: 0.2rem;
    border-radius: var(--radius-pill);
    font-weight: 500;
    line-height: 1;
    white-space: nowrap;
    box-sizing: border-box;
    border: 1px solid transparent;
}
.app-badge__icon { flex-shrink: 0; }
.app-badge--md { font-size: 0.74rem; padding: 0.15rem 0.55rem; min-height: 18px; }
.app-badge--sm { font-size: 0.68rem; padding: 0.1rem 0.45rem; min-height: 15px; }

.app-badge--mono {
    font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
    letter-spacing: 0.01em;
}

/* ───────── soft (default) ──────────────────────────────────────── */
.app-badge--soft.app-badge--tone-neutral {
    background: var(--pill-bg, var(--bg-surface-2));
    color: var(--text);
}
.app-badge--soft.app-badge--tone-accent {
    background: var(--accent-bg);
    color: var(--accent-text-strong, var(--accent));
}
.app-badge--soft.app-badge--tone-success {
    background: var(--success-bg);
    color: var(--success-text);
}
.app-badge--soft.app-badge--tone-warn {
    background: var(--warn-bg);
    color: var(--warn-text);
}
.app-badge--soft.app-badge--tone-danger {
    background: color-mix(in srgb, var(--danger) 15%, transparent);
    color: var(--danger);
}

/* ───────── outline ─────────────────────────────────────────────── */
.app-badge--outline {
    background: transparent;
}
.app-badge--outline.app-badge--tone-neutral {
    border-color: var(--border);
    color: var(--text-muted);
}
.app-badge--outline.app-badge--tone-accent {
    border-color: color-mix(in srgb, var(--accent) 50%, transparent);
    color: var(--accent-text, var(--accent));
}
.app-badge--outline.app-badge--tone-success {
    border-color: color-mix(in srgb, var(--success-text) 50%, transparent);
    color: var(--success-text);
}
.app-badge--outline.app-badge--tone-warn {
    border-color: color-mix(in srgb, var(--warn-text) 50%, transparent);
    color: var(--warn-text);
}
.app-badge--outline.app-badge--tone-danger {
    border-color: color-mix(in srgb, var(--danger) 50%, transparent);
    color: var(--danger);
}

/* ───────── solid ───────────────────────────────────────────────── */
.app-badge--solid.app-badge--tone-neutral {
    background: var(--text-muted);
    color: var(--bg-surface);
}
.app-badge--solid.app-badge--tone-accent {
    background: var(--accent);
    color: var(--text-on-accent);
}
.app-badge--solid.app-badge--tone-success {
    background: var(--success-text);
    color: var(--success-bg);
}
.app-badge--solid.app-badge--tone-warn {
    background: var(--warn-text);
    color: var(--warn-bg);
}
.app-badge--solid.app-badge--tone-danger {
    background: var(--danger);
    color: var(--bg-surface);
}
</style>

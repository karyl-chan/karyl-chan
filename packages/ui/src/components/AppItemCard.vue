<script setup lang="ts">
import { computed } from 'vue';
import { Icon } from '@iconify/vue';

/**
 * List-item card with an expandable body — the shared chrome that
 * BehaviorCard and PluginCard each re-implemented (and that PluginCard
 * was the uglier of the two, with a hand-rolled menu and no source
 * stripe).
 *
 * The component owns:
 *   - Outer card border + radius + background.
 *   - Optional left-edge accent stripe (`accentBar` prop).
 *   - The header row that holds:
 *       - `#leading` slot   (drag handle / lock icon, no click semantics)
 *       - The expand button — chevron + `#title` slot, click toggles `expanded`
 *       - `#trailing` slot  (badges / toggles / menus)
 *   - The body container that mounts the default slot when expanded.
 *   - Disabled-style strikethrough on the title when `disabled` is true.
 *
 * Everything domain-specific (which badge to show, whether to include a
 * toggle, what's in the form) stays at the caller. This deliberately
 * does NOT take an `enabled` prop or render an internal toggle — those
 * are call-site decisions, and forcing them into the API would push
 * BehaviorCard's protected-system rules and PluginCard's per-status
 * delete-only menu logic up into ui.
 */

export type AccentBarTone = 'neutral' | 'accent' | 'success' | 'warn' | 'danger';

const props = withDefaults(defineProps<{
    /** Controlled expansion. Pair with `@update:expanded`. */
    expanded?: boolean;
    /** Strike-through + muted title — used by BehaviorCard when off. */
    disabled?: boolean;
    /** Left-edge 3px accent stripe. Use to indicate source / kind. */
    accentBar?: AccentBarTone | null;
    /** Custom CSS colour for `accentBar` — overrides the tone palette. */
    accentBarColor?: string;
}>(), {
    expanded: false,
    disabled: false,
    accentBar: null,
    accentBarColor: ''
});

const emit = defineEmits<{
    (e: 'update:expanded', value: boolean): void;
    /** Fired regardless of who owns the expanded state. */
    (e: 'toggle', next: boolean): void;
}>();

const rootClass = computed(() => [
    'app-item-card',
    {
        'app-item-card--disabled': props.disabled,
        'app-item-card--bar': !!props.accentBar || !!props.accentBarColor
    }
]);

const barStyle = computed(() => {
    if (props.accentBarColor) return { background: props.accentBarColor };
    if (!props.accentBar) return undefined;
    return { background: `var(--app-item-card-bar-${props.accentBar})` };
});

function toggle(): void {
    const next = !props.expanded;
    emit('update:expanded', next);
    emit('toggle', next);
}
</script>

<template>
    <article :class="rootClass">
        <div v-if="accentBar || accentBarColor" class="app-item-card__bar" :style="barStyle" aria-hidden="true"></div>
        <div class="app-item-card__inner">
            <header class="app-item-card__head" :class="{ 'app-item-card__head--has-body': expanded }">
                <div v-if="$slots.leading" class="app-item-card__leading">
                    <slot name="leading" />
                </div>
                <button
                    type="button"
                    class="app-item-card__expander"
                    :aria-expanded="expanded"
                    @click="toggle"
                >
                    <Icon
                        :icon="expanded ? 'material-symbols:expand-less-rounded' : 'material-symbols:expand-more-rounded'"
                        width="18"
                        height="18"
                        class="app-item-card__chevron"
                    />
                    <span class="app-item-card__title">
                        <slot name="title" />
                    </span>
                </button>
                <div v-if="$slots.trailing" class="app-item-card__trailing">
                    <slot name="trailing" />
                </div>
            </header>
            <div v-if="expanded" class="app-item-card__body">
                <slot />
                <footer v-if="$slots.footer" class="app-item-card__footer">
                    <slot name="footer" />
                </footer>
            </div>
        </div>
    </article>
</template>

<style scoped>
.app-item-card {
    /* Bar tone palette — sourced from semantic tokens so themes flow through. */
    --app-item-card-bar-neutral: var(--text-muted);
    --app-item-card-bar-accent: var(--accent);
    --app-item-card-bar-success: var(--success-text);
    --app-item-card-bar-warn: var(--warn-text);
    --app-item-card-bar-danger: var(--danger);

    display: flex;
    flex-direction: row;
    border: 1px solid var(--border);
    border-radius: var(--radius-base);
    background: var(--bg-surface);
    overflow: hidden;
}
.app-item-card--disabled .app-item-card__title {
    color: var(--text-muted);
    text-decoration: line-through;
}

.app-item-card__bar {
    width: 3px;
    flex-shrink: 0;
    border-radius: var(--radius-base) 0 0 var(--radius-base);
}

.app-item-card__inner {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
}

.app-item-card__head {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.45rem 0.75rem 0.45rem 0.4rem;
    background: var(--bg-page);
    border-bottom: 1px solid transparent;
}
.app-item-card__head--has-body {
    border-bottom-color: var(--border);
}

.app-item-card__leading {
    display: inline-flex;
    align-items: center;
    flex-shrink: 0;
}

.app-item-card__expander {
    flex: 1;
    min-width: 0;
    background: none;
    border: none;
    text-align: left;
    cursor: pointer;
    color: var(--text);
    display: flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.25rem 0.1rem;
    overflow: hidden;
    font: inherit;
}
.app-item-card__expander:hover { color: var(--text-strong); }
.app-item-card__expander:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -1px;
    border-radius: var(--radius-sm);
}
.app-item-card__chevron {
    color: var(--text-muted);
    flex-shrink: 0;
}
.app-item-card__title {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 0.4rem;
    overflow: hidden;
}

.app-item-card__trailing {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    flex-shrink: 0;
}

.app-item-card__body {
    padding: 0.75rem;
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
}
.app-item-card__footer {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
}
</style>

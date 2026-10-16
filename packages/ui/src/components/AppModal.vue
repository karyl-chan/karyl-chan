<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, useId, useSlots, watch } from 'vue';
import { Icon } from '@iconify/vue';
import { useBreakpoint } from '../composables/use-breakpoint';
import { useDrawer } from '../composables/use-drawer';
import { useEscapeStack } from '../composables/use-escape-stack';
import { useBodyScrollLock } from '../composables/use-scroll-lock';
import { getFocusable, trapTabKey } from '../lib/focus';

/**
 * Viewport-aware modal:
 * - Desktop → centered card with a translucent backdrop, fade transition.
 * - Mobile  → bottom drawer using the shared `useDrawer` styles, slide-up
 *   transition, drag-handle visual cue, safe-area inset.
 *
 * The caller owns everything inside the slot — typical usage is to drop
 * a `<form @submit.prevent>` containing fields + an actions footer
 * directly into the default slot. AppModal supplies the chrome (backdrop,
 * panel, optional title header, close button) and pads the body with
 * `padding` (default `0.8rem 0.9rem`, both viewport branches). Slot
 * content therefore needs no padding of its own; pass `padding="0"` for
 * full-bleed content (tables, pickers, croppers) that manages its own
 * edges.
 *
 * `closeOnBackdrop` / `closeOnEscape` default to true. Escape goes
 * through the shared escape stack on both branches, so with stacked
 * overlays only the topmost one closes. Backdrop close requires the
 * press to START and END on the backdrop — a text-selection drag that
 * ends outside the panel doesn't dismiss.
 *
 * Accessibility: the panel is `role="dialog"` + `aria-modal`, labelled by
 * the title (or `ariaLabel` when there is none). On open, focus moves to
 * the first `[autofocus]` element, else the first focusable control in
 * the body, else the panel itself; Tab / Shift+Tab cycle inside the
 * panel; on close focus returns to whatever had it before. While any
 * AppModal is open the page behind it can't scroll (ref-counted, so
 * stacked modals behave).
 */
const props = withDefaults(defineProps<{
    visible: boolean;
    /** Heading rendered in the panel's header. Hidden when blank. */
    title?: string;
    /**
     * Accessible name for the dialog when there is no `title` / `#header`
     * (those label the dialog via aria-labelledby and take precedence).
     */
    ariaLabel?: string;
    /** Accessible label of the header close button. Default: 'Close'. */
    closeLabel?: string;
    closeOnBackdrop?: boolean;
    closeOnEscape?: boolean;
    /** Width of the desktop panel; mobile drawer ignores this. */
    width?: string;
    /**
     * CSS padding of the scrollable body around the default slot. Use
     * `'0'` for full-bleed content that manages its own edges.
     */
    padding?: string;
}>(), {
    title: '',
    ariaLabel: undefined,
    closeLabel: 'Close',
    closeOnBackdrop: true,
    closeOnEscape: true,
    width: 'min(440px, 92vw)',
    padding: '0.8rem 0.9rem'
});

const emit = defineEmits<{
    (e: 'close'): void;
}>();

const slots = useSlots();

const { isMobile } = useBreakpoint();
const visibleRef = computed(() => props.visible);
const desktopVisible = computed(() => props.visible && !isMobile.value);
const drawerVisible = computed(() => props.visible && isMobile.value);

const titleId = useId();
const hasHeader = computed(() => !!props.title || !!slots.header);
const labelledBy = computed(() => (hasHeader.value ? titleId : undefined));
const label = computed(() => (hasHeader.value ? undefined : props.ariaLabel || undefined));

// Escape is checked at call time (not captured at setup) so toggling
// `closeOnEscape` — e.g. AppConfirmDialog while `loading` — takes effect
// immediately. A modal with `closeOnEscape: false` still swallows the
// key instead of letting it fall through to an overlay underneath.
function onEscape() {
    if (props.closeOnEscape) emit('close');
}

// Desktop branch: register on the shared escape stack so only the
// topmost overlay (modal, drawer or popover) reacts to a single Escape.
const escapeStack = useEscapeStack();
watch(desktopVisible, (v) => {
    if (v) escapeStack.register(onEscape);
    else escapeStack.unregister();
}, { immediate: true });
onBeforeUnmount(escapeStack.unregister);

// Mobile branch: useDrawer owns its own escape-stack entry.
const { backdropClass, panelClass, backdropTransition, panelTransition } = useDrawer({
    visible: drawerVisible,
    placement: 'bottom',
    closeOnEscape: true,
    onClose: onEscape
});

useBodyScrollLock(visibleRef);

// Backdrop close only when the press both started and ended on the
// backdrop itself.
let pressStartedOnBackdrop = false;
function onBackdropPointerDown(event: PointerEvent | MouseEvent) {
    pressStartedOnBackdrop = event.target === event.currentTarget;
}
function onBackdropClick(event: MouseEvent) {
    const startedHere = pressStartedOnBackdrop;
    pressStartedOnBackdrop = false;
    if (event.target !== event.currentTarget || !startedHere) return;
    if (props.closeOnBackdrop) emit('close');
}

// ── Focus management ────────────────────────────────────────────────
const desktopPanel = ref<HTMLElement | null>(null);
const drawerPanel = ref<HTMLElement | null>(null);
const activePanel = () => (isMobile.value ? drawerPanel.value : desktopPanel.value);

let returnFocusTo: HTMLElement | null = null;

function focusInitial() {
    const panel = activePanel();
    if (!panel) return;
    const active = document.activeElement;
    if (active && panel.contains(active) && active !== panel) return;
    const auto = panel.querySelector<HTMLElement>('[autofocus]');
    const body = panel.querySelector<HTMLElement>('.app-modal-body, .app-modal-drawer-body');
    const target = auto ?? (body ? getFocusable(body)[0] : undefined) ?? panel;
    target.focus({ preventScroll: true });
}

function restoreFocus() {
    const el = returnFocusTo;
    returnFocusTo = null;
    if (!el || !el.isConnected) return;
    // Don't yank focus back if the user (or the caller) already moved it
    // somewhere meaningful outside the dialog.
    const active = document.activeElement;
    const panels = [desktopPanel.value, drawerPanel.value];
    const focusInDialog = !!active && panels.some((p) => p?.contains(active));
    if (!active || active === document.body || focusInDialog) {
        el.focus({ preventScroll: true });
    }
}

watch(visibleRef, (v, was) => {
    if (v && !was) {
        const active = document.activeElement;
        returnFocusTo = active instanceof HTMLElement && active !== document.body ? active : null;
    } else if (!v && was) {
        restoreFocus();
    }
}, { immediate: true });

// Move focus in whenever a branch's panel appears — on open, and when a
// breakpoint flip swaps the desktop card for the mobile drawer.
watch([desktopVisible, drawerVisible], ([d, m]) => {
    if (d || m) nextTick(focusInitial);
}, { immediate: true, flush: 'post' });

onBeforeUnmount(() => {
    if (props.visible) restoreFocus();
});

function onPanelKeydown(event: KeyboardEvent) {
    trapTabKey(event, event.currentTarget as HTMLElement);
}
</script>

<template>
    <Teleport to="body">
        <!-- Desktop branch — centered card. -->
        <Transition name="app-modal-fade">
            <div
                v-if="desktopVisible"
                class="app-modal-backdrop"
                @pointerdown="onBackdropPointerDown"
                @click="onBackdropClick"
            >
                <div
                    ref="desktopPanel"
                    class="app-modal-panel"
                    role="dialog"
                    aria-modal="true"
                    tabindex="-1"
                    :style="{ width }"
                    :aria-labelledby="labelledBy"
                    :aria-label="label"
                    @keydown="onPanelKeydown"
                >
                    <header v-if="hasHeader" class="app-modal-head">
                        <span :id="titleId" class="app-modal-title">
                            <slot name="header">{{ title }}</slot>
                        </span>
                        <button
                            type="button"
                            class="app-modal-close"
                            :aria-label="closeLabel"
                            @click="emit('close')"
                        >
                            <Icon icon="material-symbols:close-rounded" width="18" height="18" />
                        </button>
                    </header>
                    <div class="app-modal-body" :style="{ padding }">
                        <slot />
                    </div>
                </div>
            </div>
        </Transition>
    </Teleport>

    <!-- Mobile drawer branch — slides up from the bottom edge. -->
    <Teleport to="body">
        <Transition :name="backdropTransition">
            <div
                v-if="drawerVisible"
                :class="[backdropClass, 'app-modal-drawer-backdrop']"
                @pointerdown="onBackdropPointerDown"
                @click="onBackdropClick"
            />
        </Transition>
        <Transition :name="panelTransition">
            <div
                v-if="drawerVisible"
                ref="drawerPanel"
                :class="[panelClass, 'app-modal-drawer-panel']"
                data-placement="bottom"
                role="dialog"
                aria-modal="true"
                tabindex="-1"
                :aria-labelledby="labelledBy"
                :aria-label="label"
                @keydown="onPanelKeydown"
            >
                <header v-if="hasHeader" class="app-modal-drawer-head">
                    <span :id="titleId" class="app-modal-title">
                        <slot name="header">{{ title }}</slot>
                    </span>
                    <button
                        type="button"
                        class="app-modal-close"
                        :aria-label="closeLabel"
                        @click="emit('close')"
                    >
                        <Icon icon="material-symbols:close-rounded" width="18" height="18" />
                    </button>
                </header>
                <div class="app-modal-drawer-body" :style="{ padding }">
                    <slot />
                </div>
            </div>
        </Transition>
    </Teleport>
</template>

<style scoped>
/* ── Desktop ────────────────────────────────────────────────────── */
.app-modal-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.45);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1500;
}
.app-modal-panel {
    max-height: 88vh;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    box-shadow: 0 12px 36px rgba(0, 0, 0, 0.32);
    display: flex;
    flex-direction: column;
    overflow: hidden;
}
.app-modal-panel:focus,
.app-modal-drawer-panel:focus {
    /* The panel only takes focus as a fallback target (tabindex=-1);
       don't paint a ring around the whole card. */
    outline: none;
}
.app-modal-head {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.6rem 0.9rem;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
}
.app-modal-title {
    flex: 1;
    font-weight: 600;
    color: var(--text-strong);
}
.app-modal-close {
    background: none;
    border: none;
    color: var(--text-muted);
    cursor: pointer;
    padding: 0.5rem;
    min-width: 44px;
    min-height: 44px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
}
.app-modal-close:hover { color: var(--text); }

.app-modal-fade-enter-active,
.app-modal-fade-leave-active { transition: opacity 0.18s ease; }
.app-modal-fade-enter-from,
.app-modal-fade-leave-to { opacity: 0; }

/* ── Mobile drawer ──────────────────────────────────────────────── */
/* useDrawer injects .drawer-backdrop / .drawer-panel positioning &
   transitions; this layer adds the modal-specific chrome (rounded top,
   shadow, max-height, safe-area inset, drag-handle). */
.app-modal-drawer-backdrop {
    z-index: 1500;
}
.app-modal-drawer-panel {
    z-index: 1501;
    border-top: 1px solid var(--border);
    border-radius: 14px 14px 0 0;
    box-shadow: 0 -8px 24px rgba(0, 0, 0, 0.28);
    max-height: 88vh;
    padding-bottom: env(safe-area-inset-bottom, 0px);
}
.app-modal-drawer-panel::before {
    content: '';
    display: block;
    width: 36px;
    height: 4px;
    border-radius: 2px;
    background: var(--text-muted);
    opacity: 0.35;
    margin: 0.4rem auto 0;
    flex-shrink: 0;
}
.app-modal-drawer-head {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 0.9rem 0.6rem;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
}
.app-modal-drawer-body {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    overflow-x: hidden;
}

/* ── Desktop body wrapper ───────────────────────────────────────── */
/* Structural wrapper that matches the mobile .app-modal-drawer-body.
   Padding comes from the `padding` prop (inline style) on both
   branches so slot content needs none of its own. */
.app-modal-body {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    overflow-x: hidden;
}
</style>

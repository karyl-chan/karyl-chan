<script setup lang="ts">
/**
 * AppTabsRouted — AppTabs with URL query-param sync via `vue-router`.
 *
 * Tab + sub-tab keys two-way sync with URL query params, so a deep-link
 * like `?tab=settings&sub=invites` lands on the right card and
 * middle-clicking a tab opens it in a new browser tab.
 *
 * The first tab/sub key is treated as the default and omitted from the
 * URL to keep shared links short. When two routed AppTabs share the
 * same page, give each one a unique `name` prop so their query keys
 * don't collide (`name="foo"` → `foo-tab` / `foo-sub`).
 *
 * For non-routed callers, use `AppTabs` (this file's plain sibling) —
 * which does NOT import vue-router and so doesn't pull it into your
 * plugin SPA's bundle.
 *
 * NB: separate component (vs an `routed` prop on AppTabs) so that
 * plugin SPAs that never use routed tabs don't transitively depend on
 * `vue-router`.
 */
import { computed, ref, watch } from 'vue';
import { useRoute, useRouter, RouterLink, type LocationQueryRaw } from 'vue-router';
import { Icon } from '@iconify/vue';
import { useBreakpoint } from '../composables/use-breakpoint';
import AppSelectField, { type SelectOption } from './AppSelectField.vue';
import type { TabDef } from './tab-types';

const props = withDefaults(defineProps<{
    modelValue: string;
    tabs: TabDef[];
    subModelValue?: string;
    subTabs?: TabDef[];
    subLayout?: 'top' | 'sidebar';
    /** Namespace prefix for the URL query keys; required when multiple
     *  routed AppTabs share a page. Empty (default) = plain `tab` /
     *  `sub`; non-empty = `${name}-tab` / `${name}-sub`. */
    name?: string;
}>(), {
    subModelValue: undefined,
    subTabs: () => [],
    subLayout: 'top',
    name: ''
});

const emit = defineEmits<{
    (e: 'update:modelValue', value: string): void;
    (e: 'update:subModelValue', value: string): void;
}>();

const { isMobile } = useBreakpoint();
const route = useRoute();
const router = useRouter();

const hasSub = computed(() => props.subTabs.length > 0);

const tabKey = computed(() => props.name ? `${props.name}-tab` : 'tab');
const subKey = computed(() => props.name ? `${props.name}-sub` : 'sub');
const defaultTab = computed(() => props.tabs[0]?.key ?? '');
const defaultSub = computed(() => props.subTabs[0]?.key ?? '');

function pickPrimary(key: string) { emit('update:modelValue', key); }
function pickSub(key: string) { emit('update:subModelValue', key); }

const primaryOptions = computed<SelectOption<string>[]>(() =>
    props.tabs.map(t => ({ value: t.key, label: t.label }))
);
const subOptions = computed<SelectOption<string>[]>(() =>
    props.subTabs.map(t => ({ value: t.key, label: t.label }))
);

function readQuery(key: string): string {
    const v = route.query[key];
    return typeof v === 'string' ? v : '';
}

function readFromRoute() {
    const wantTab = readQuery(tabKey.value) || defaultTab.value;
    if (wantTab && wantTab !== props.modelValue) emit('update:modelValue', wantTab);

    if (props.subModelValue === undefined) return;
    const wantSub = readQuery(subKey.value) || defaultSub.value;
    if (wantSub && wantSub !== props.subModelValue) emit('update:subModelValue', wantSub);
}

function syncToRoute() {
    const next: LocationQueryRaw = { ...route.query };
    next[tabKey.value] = props.modelValue && props.modelValue !== defaultTab.value
        ? props.modelValue : undefined;
    next[subKey.value] = props.subModelValue && props.subModelValue !== defaultSub.value
        ? props.subModelValue : undefined;

    if ((route.query[tabKey.value] ?? null) === (next[tabKey.value] ?? null)
        && (route.query[subKey.value] ?? null) === (next[subKey.value] ?? null)) {
        return;
    }
    router.replace({ query: next });
}

// Seed from the URL on mount before any state→URL watcher fires —
// otherwise the initial sync would clobber the deep-link.
readFromRoute();

watch(() => [props.modelValue, props.subModelValue], () => syncToRoute());
watch(() => route.query, () => readFromRoute());

// Per-primary-tab memory of the last non-default sub the user picked.
const subMemory = ref<Record<string, string>>({});
watch(
    () => [props.modelValue, props.subModelValue, defaultSub.value] as const,
    ([tab, sub, def]) => {
        if (tab && typeof sub === 'string' && sub && sub !== def) {
            subMemory.value[tab] = sub;
        }
    },
    { immediate: true }
);

function tabLinkTo(key: string) {
    const q: LocationQueryRaw = { ...route.query };
    q[tabKey.value] = key === defaultTab.value ? undefined : key;
    const remembered = subMemory.value[key];
    q[subKey.value] = remembered ?? undefined;
    return { path: route.path, query: q };
}
function subLinkTo(key: string) {
    const q: LocationQueryRaw = { ...route.query };
    q[subKey.value] = key === defaultSub.value ? undefined : key;
    return { path: route.path, query: q };
}
</script>

<template>
    <!-- Mobile: two stacked dropdowns. -->
    <div v-if="isMobile" class="tabs-root mobile">
        <div class="dropdowns">
            <AppSelectField
                :model-value="modelValue"
                :options="primaryOptions"
                @update:model-value="pickPrimary"
            />
            <AppSelectField
                v-if="hasSub && subModelValue !== undefined"
                :model-value="subModelValue"
                :options="subOptions"
                @update:model-value="pickSub"
            />
        </div>
        <div class="panel">
            <slot />
        </div>
    </div>

    <!-- Desktop, sub-tabs below primary. -->
    <div
        v-else-if="!hasSub || subLayout === 'top'"
        class="tabs-root desktop top"
    >
        <nav class="primary-row" role="tablist">
            <template v-for="t in tabs" :key="t.key">
                <RouterLink
                    v-if="!t.disabled"
                    :to="tabLinkTo(t.key)"
                    role="tab"
                    :class="['tab', { active: t.key === modelValue }]"
                    :aria-selected="t.key === modelValue"
                >
                    <Icon v-if="t.icon" :icon="t.icon" width="16" height="16" />
                    <span>{{ t.label }}</span>
                </RouterLink>
                <button
                    v-else
                    type="button"
                    role="tab"
                    :class="['tab', { active: t.key === modelValue }]"
                    :aria-selected="t.key === modelValue"
                    disabled
                >
                    <Icon v-if="t.icon" :icon="t.icon" width="16" height="16" />
                    <span>{{ t.label }}</span>
                </button>
            </template>
        </nav>
        <nav v-if="hasSub" class="sub-row" role="tablist">
            <template v-for="t in subTabs" :key="t.key">
                <RouterLink
                    v-if="!t.disabled"
                    :to="subLinkTo(t.key)"
                    role="tab"
                    :class="['sub-tab', { active: t.key === subModelValue }]"
                    :aria-selected="t.key === subModelValue"
                >
                    <Icon v-if="t.icon" :icon="t.icon" width="14" height="14" />
                    <span>{{ t.label }}</span>
                </RouterLink>
                <button
                    v-else
                    type="button"
                    role="tab"
                    :class="['sub-tab', { active: t.key === subModelValue }]"
                    :aria-selected="t.key === subModelValue"
                    disabled
                >
                    <Icon v-if="t.icon" :icon="t.icon" width="14" height="14" />
                    <span>{{ t.label }}</span>
                </button>
            </template>
        </nav>
        <div class="panel">
            <slot />
        </div>
    </div>

    <!-- Desktop, sub-tabs as a vertical sidebar. -->
    <div v-else class="tabs-root desktop sidebar">
        <nav class="primary-row" role="tablist">
            <template v-for="t in tabs" :key="t.key">
                <RouterLink
                    v-if="!t.disabled"
                    :to="tabLinkTo(t.key)"
                    role="tab"
                    :class="['tab', { active: t.key === modelValue }]"
                    :aria-selected="t.key === modelValue"
                >
                    <Icon v-if="t.icon" :icon="t.icon" width="16" height="16" />
                    <span>{{ t.label }}</span>
                </RouterLink>
                <button
                    v-else
                    type="button"
                    role="tab"
                    :class="['tab', { active: t.key === modelValue }]"
                    :aria-selected="t.key === modelValue"
                    disabled
                >
                    <Icon v-if="t.icon" :icon="t.icon" width="16" height="16" />
                    <span>{{ t.label }}</span>
                </button>
            </template>
        </nav>
        <div class="split">
            <nav class="sub-side" role="tablist">
                <template v-for="t in subTabs" :key="t.key">
                    <RouterLink
                        v-if="!t.disabled"
                        :to="subLinkTo(t.key)"
                        role="tab"
                        :class="['sub-side-tab', { active: t.key === subModelValue }]"
                        :aria-selected="t.key === subModelValue"
                    >
                        <Icon v-if="t.icon" :icon="t.icon" width="16" height="16" />
                        <span>{{ t.label }}</span>
                    </RouterLink>
                    <button
                        v-else
                        type="button"
                        role="tab"
                        :class="['sub-side-tab', { active: t.key === subModelValue }]"
                        :aria-selected="t.key === subModelValue"
                        disabled
                    >
                        <Icon v-if="t.icon" :icon="t.icon" width="16" height="16" />
                        <span>{{ t.label }}</span>
                    </button>
                </template>
            </nav>
            <div class="panel side-panel">
                <slot />
            </div>
        </div>
    </div>
</template>

<style scoped>
.tabs-root {
    display: flex;
    flex-direction: column;
    gap: 0.7rem;
    min-height: 0;
    flex: 1;
}

.primary-row {
    display: flex;
    gap: 0.4rem;
    border-bottom: 1px solid var(--border);
    padding-bottom: 0.5rem;
    overflow-x: auto;
    scrollbar-width: thin;
    flex-shrink: 0;
}
.tab {
    background: var(--bg-surface-2);
    border: 1px solid transparent;
    border-radius: var(--radius-base);
    padding: 0.4rem 0.95rem;
    cursor: pointer;
    color: var(--text);
    font: inherit;
    font-size: 0.9rem;
    font-weight: 500;
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    white-space: nowrap;
    text-decoration: none;
}
.tab:hover:not(:disabled) { background: var(--bg-surface-hover); }
.tab.active {
    background: var(--accent-bg);
    border-color: var(--accent);
    color: var(--accent-text-strong);
}
.tab:disabled { opacity: 0.45; cursor: default; }

.sub-row {
    display: flex;
    gap: 0.6rem;
    border-bottom: 1px solid var(--border);
    overflow-x: auto;
    scrollbar-width: thin;
    margin-top: -0.3rem;
    flex-shrink: 0;
}
.sub-tab {
    background: none;
    border: none;
    color: var(--text-muted);
    font: inherit;
    font-size: 0.85rem;
    font-weight: 500;
    padding: 0.45rem 0.2rem;
    cursor: pointer;
    border-bottom: 2px solid transparent;
    margin-bottom: -1px;
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    white-space: nowrap;
    text-decoration: none;
}
.sub-tab:hover:not(:disabled) { color: var(--text); }
.sub-tab.active { color: var(--accent-text-strong); border-color: var(--accent); }
.sub-tab:disabled { opacity: 0.45; cursor: default; }

.split {
    display: flex;
    gap: 0.9rem;
    flex: 1;
    min-height: 0;
}
.sub-side {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    width: 200px;
    flex-shrink: 0;
    border-right: 1px solid var(--border);
    padding-right: 0.6rem;
    overflow-y: auto;
}
.sub-side-tab {
    background: none;
    border: 1px solid transparent;
    border-radius: var(--radius-base);
    padding: 0.5rem 0.7rem;
    text-align: left;
    color: var(--text-muted);
    font: inherit;
    font-size: 0.88rem;
    font-weight: 500;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    text-decoration: none;
}
.sub-side-tab:hover:not(:disabled) {
    background: var(--bg-surface-hover);
    color: var(--text);
}
.sub-side-tab.active {
    background: var(--accent-bg);
    color: var(--accent-text-strong);
    border-color: var(--accent);
}
.sub-side-tab:disabled { opacity: 0.45; cursor: default; }

.panel {
    flex: 1;
    min-width: 0;
    min-height: 0;
    overflow-y: auto;
}
.side-panel {
    padding-right: 0.2rem;
}

.tabs-root.mobile { gap: 0.5rem; }
.dropdowns {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
}

@media (max-width: 640px) {
    .sub-side { width: 160px; }
}
</style>

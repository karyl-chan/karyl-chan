<script setup lang="ts">
/**
 * ShowcaseView — every @karyl-chan/ui component, split into tabs.
 *
 * Visual catalog + smoke test that the package's tree-shaking + side-
 * effect-free imports work end-to-end. Each tab triggers a related
 * cluster of components in a few representative configurations.
 *
 * AppTabsRouted is intentionally NOT shown — pulling it in would force
 * `vue-router` into this plugin's bundle and defeat the point of the
 * Base/Routed split. There's a note in the Layout tab.
 *
 * Tab choice survives reload via sessionStorage so /example-showcase
 * lands you back where you were after a refresh.
 */
import { onMounted, ref, watch } from "vue";
import { fetchMe, type MeResponse } from "../api";
import {
  AppBadge,
  AppButton,
  AppConfirmDialog,
  AppItemCard,
  AppMenu,
  AppMenuItem,
  AppModal,
  AppPopover,
  AppSelect,
  AppSelectField,
  AppTabs,
  AppTextArea,
  AppTextField,
  AppToggle,
  Draggable,
  UnreadPill,
  UserAvatar,
  UserCard,
  UserItem,
  useColorScheme,
  useConfirm,
  usePopover,
  useToastStore,
  type ColorScheme,
} from "@karyl-chan/ui";

const toast = useToastStore();
const { confirm } = useConfirm();

// ── Theme ─────────────────────────────────────────────────────────
const { colorScheme, setColorScheme } = useColorScheme();
const colorSchemeOptions: { value: ColorScheme; label: string }[] = [
  { value: "system", label: "跟隨系統" },
  { value: "light", label: "亮色" },
  { value: "dark", label: "暗色" },
];

// ── Active tab (persisted) ────────────────────────────────────────
type TabKey = "form" | "overlay" | "layout" | "display" | "user" | "misc";
const TAB_STORAGE_KEY = "karyl-example:showcase-tab";
function readStoredTab(): TabKey {
  if (typeof sessionStorage === "undefined") return "form";
  try {
    const v = sessionStorage.getItem(TAB_STORAGE_KEY);
    if (v === "form" || v === "overlay" || v === "layout" || v === "display" || v === "user" || v === "misc") {
      return v;
    }
  } catch { /* fall through */ }
  return "form";
}
const activeTab = ref<TabKey>(readStoredTab());
watch(activeTab, (v) => {
  if (typeof sessionStorage === "undefined") return;
  try { sessionStorage.setItem(TAB_STORAGE_KEY, v); } catch { /* ignore */ }
});

const tabs = [
  { key: "form", label: "Form" },
  { key: "overlay", label: "Overlay" },
  { key: "layout", label: "Layout" },
  { key: "display", label: "Display" },
  { key: "user", label: "User" },
  { key: "misc", label: "Misc" },
];

// ── Form-tab state ────────────────────────────────────────────────
const toggleA = ref(true);
const toggleB = ref(false);
const toggleSm = ref(true);
const textName = ref("");
const textNumber = ref("");
const textArea = ref("Multi-line content goes here.");
const textError = ref("oops");
const selectOpen = ref(false);
const selectValue = ref<string>("alpha");
const selectOptions = [
  { value: "alpha", label: "Alpha" },
  { value: "beta", label: "Beta" },
  { value: "gamma", label: "Gamma", group: "Greeks" },
  { value: "delta", label: "Delta", group: "Greeks" },
];
const fieldValue = ref<string>("");

// ── Overlay-tab state ─────────────────────────────────────────────
const modalOpen = ref(false);
const inlineConfirmOpen = ref(false);
const inlineLoading = ref(false);
const popoverOpen = ref(false);

// ── Layout-tab state ──────────────────────────────────────────────
const subTab = ref("a");
const innerTab = ref("first");
const itemAEnabled = ref(true);
const itemAOpen = ref(true);
const itemBEnabled = ref(false);
const itemBOpen = ref(false);

// ── Misc-tab state ────────────────────────────────────────────────
const dragBoundsRef = ref<HTMLElement | null>(null);

// ── User-tab state ────────────────────────────────────────────────
// Real viewer data — fetched from /api/me (plugin → bot members.get).
// avatarUrl already has `?animated=true` baked in when animated.
const me = ref<MeResponse | null>(null);
const meError = ref<string | null>(null);

onMounted(async () => {
  try {
    me.value = await fetchMe();
  } catch (err) {
    meError.value = err instanceof Error ? err.message : "Failed to load /api/me";
  }
});

// Avatar popover — usePopover composable directly (not AppPopover).
// Shows the lower-level wiring: refs for trigger + content, then
// usePopover handles flipping / click-outside / Escape. The popover
// content is a UserCard, so clicking the avatar opens a profile.
const avatarTriggerRef = ref<HTMLElement | null>(null);
const avatarPopoverRef = ref<HTMLElement | null>(null);
const { isVisible: avatarPopoverOpen } = usePopover(
  avatarTriggerRef,
  avatarPopoverRef,
  {
    placement: "bottom-start",
    trigger: "click",
    offset: [0, 10],
    teleportTo: "body",
    closeOnContentClick: false,
  },
);

// ── Overlay handlers ──────────────────────────────────────────────
function triggerGlobalConfirm() {
  confirm({
    title: "Really do the thing?",
    message: "This is the GlobalConfirmDialog — module-level state, no provider needed.",
    confirmLabel: "Yes, do it",
    confirmVariant: "danger",
  }).then((ok) => {
    toast.show(ok ? "Confirmed" : "Cancelled", "info");
  });
}

function inlineConfirm() {
  inlineConfirmOpen.value = true;
}
function onInlineConfirm() {
  inlineLoading.value = true;
  setTimeout(() => {
    inlineLoading.value = false;
    inlineConfirmOpen.value = false;
    toast.show("Inline confirm: confirmed", "info");
  }, 800);
}
function onInlineClose() {
  if (inlineLoading.value) return;
  inlineConfirmOpen.value = false;
}
</script>

<template>
  <div class="showcase">
    <header class="page-header">
      <div class="page-header__text">
        <h1>@karyl-chan/ui Showcase</h1>
        <p class="lede">
          Every component, with a few representative configurations.
        </p>
      </div>
      <div class="theme-picker">
        <span class="theme-picker-label">主題</span>
        <AppSelectField
          :model-value="colorScheme"
          :options="colorSchemeOptions"
          @update:model-value="setColorScheme"
        />
      </div>
    </header>

    <AppTabs v-model="activeTab" :tabs="tabs">

      <!-- ═════════════ Form tab ═════════════ -->
      <div v-if="activeTab === 'form'" class="tab-panel">
        <section>
          <h2>AppButton</h2>
          <p class="hint">Variant + size + state combinations.</p>
          <div class="row">
            <AppButton variant="primary">Primary</AppButton>
            <AppButton variant="secondary">Secondary</AppButton>
            <AppButton variant="danger">Danger</AppButton>
            <AppButton variant="ghost">Ghost</AppButton>
          </div>
          <div class="row">
            <AppButton size="sm">Small</AppButton>
            <AppButton size="md">Medium</AppButton>
            <AppButton size="lg">Large</AppButton>
            <AppButton loading>Loading</AppButton>
            <AppButton disabled>Disabled</AppButton>
            <AppButton icon="material-symbols:add-rounded">With icon</AppButton>
          </div>
        </section>

        <section>
          <h2>AppToggle</h2>
          <p class="hint">
            Pill-shaped on/off switch. <code>v-model</code> is a boolean;
            <code>size</code> is <code>md</code> (default, 32×18) or
            <code>sm</code> (26×15). Pair with an external label — the
            toggle itself only exposes a name via <code>ariaLabel</code>.
          </p>
          <div class="toggle-grid">
            <div class="toggle-cell">
              <AppToggle v-model="toggleA" aria-label="Demo toggle A" />
              <span>On: <code>{{ toggleA }}</code></span>
            </div>
            <div class="toggle-cell">
              <AppToggle v-model="toggleB" aria-label="Demo toggle B" />
              <span>Off: <code>{{ toggleB }}</code></span>
            </div>
            <div class="toggle-cell">
              <AppToggle v-model="toggleSm" size="sm" aria-label="Small demo" />
              <span>Small</span>
            </div>
            <div class="toggle-cell">
              <AppToggle :model-value="true" disabled aria-label="Disabled on" />
              <span>Disabled (on)</span>
            </div>
            <div class="toggle-cell">
              <AppToggle :model-value="false" disabled aria-label="Disabled off" />
              <span>Disabled (off)</span>
            </div>
          </div>
        </section>

        <section>
          <h2>AppTextField &amp; AppTextArea</h2>
          <p class="hint">
            Single-line + multi-line text inputs with the shared label /
            hint / error chrome. <code>fullWidth</code> makes the field
            span an entire row in a parent <code>.grid</code>.
          </p>
          <div class="form-grid">
            <AppTextField v-model="textName" label="Display name" placeholder="e.g. Karyl-chan" hint="Shown in greetings." />
            <AppTextField v-model="textNumber" label="Port" type="number" placeholder="3000" />
            <AppTextField v-model="textError" label="With error" :error="textError ? '' : 'Required'" />
            <AppTextField :model-value="'sk_live_********'" label="Read-only" readonly muted />
          </div>
          <AppTextArea v-model="textArea" label="Description" :rows="3" hint="Wraps and grows; resize handle is vertical only." full-width />
        </section>

        <section>
          <h2>AppSelectField (form-input)</h2>
          <p class="hint">Drop-in replacement for native <code>&lt;select&gt;</code>, with optional filter for long option lists.</p>
          <div class="field">
            <label>Greek letter</label>
            <AppSelectField v-model="fieldValue" :options="selectOptions" placeholder="Pick one" filter />
          </div>
          <p class="result">Value: <code>{{ fieldValue || "(none)" }}</code></p>
        </section>

        <section>
          <h2>AppSelect (raw)</h2>
          <p class="hint">
            Headless dropdown. Most callers will want AppSelectField instead —
            but AppSelect is here for custom triggers / lists.
          </p>
          <AppSelect v-model:open="selectOpen">
            <template #trigger>
              <button type="button" class="anchor">
                Selected: {{ selectValue }} (open: {{ selectOpen }})
              </button>
            </template>
            <ul class="custom-list">
              <li v-for="o in selectOptions" :key="o.value" @click="selectValue = o.value; selectOpen = false">
                {{ o.label }}
              </li>
            </ul>
          </AppSelect>
        </section>
      </div>

      <!-- ═════════════ Overlay tab ═════════════ -->
      <div v-else-if="activeTab === 'overlay'" class="tab-panel">
        <section>
          <h2>AppToast &amp; useToastStore</h2>
          <p class="hint">Fire toasts from the global store (Pinia).</p>
          <div class="row">
            <AppButton @click="toast.show('Info toast', 'info')">Info</AppButton>
            <AppButton variant="danger" @click="toast.show('Error toast', 'error')">Error</AppButton>
          </div>
        </section>

        <section>
          <h2>GlobalConfirmDialog &amp; useConfirm</h2>
          <p class="hint">
            Module-level confirm — call <code>useConfirm().confirm(opts)</code> from anywhere,
            the dialog mounted in <code>App.vue</code> picks it up.
          </p>
          <AppButton variant="danger" @click="triggerGlobalConfirm">Trigger global confirm</AppButton>
        </section>

        <section>
          <h2>AppModal &amp; AppConfirmDialog</h2>
          <p class="hint">AppModal is the chrome; AppConfirmDialog wraps it for the common confirm pattern.</p>
          <div class="row">
            <AppButton @click="modalOpen = true">Open AppModal</AppButton>
            <AppButton @click="inlineConfirm">Open inline AppConfirmDialog</AppButton>
          </div>
          <AppModal :visible="modalOpen" title="Hello from AppModal" @close="modalOpen = false">
            <div class="modal-body">
              <p>The default slot is yours — drop a form, a list, anything.</p>
              <p>Backdrop click, Escape, and the close button all emit <code>@close</code>.</p>
              <div class="row" style="justify-content:flex-end;">
                <AppButton variant="ghost" @click="modalOpen = false">Cancel</AppButton>
                <AppButton variant="primary" @click="modalOpen = false">OK</AppButton>
              </div>
            </div>
          </AppModal>
          <AppConfirmDialog
            :visible="inlineConfirmOpen"
            title="Inline confirm"
            message="Loading state demo: pretend this kicks off an async op for 800 ms."
            confirm-label="Run it"
            :loading="inlineLoading"
            @confirm="onInlineConfirm"
            @close="onInlineClose"
          />
        </section>

        <section>
          <h2>AppMenu &amp; AppMenuItem</h2>
          <p class="hint">
            Anchored menu — viewport-aware (mobile = drawer). The <code>#trigger</code>
            slot owns its own click; clicking any AppMenuItem closes the menu.
          </p>
          <AppMenu drawer-title="Menu">
            <template #trigger>
              <button type="button" class="anchor">Open menu</button>
            </template>
            <AppMenuItem icon="material-symbols:bolt-rounded" @click="toast.show('Run', 'info')">
              Run task
            </AppMenuItem>
            <AppMenuItem icon="material-symbols:pause-rounded" @click="toast.show('Pause', 'info')">
              Pause
            </AppMenuItem>
            <AppMenuItem danger icon="material-symbols:delete-rounded" @click="toast.show('Delete', 'error')">
              Delete
            </AppMenuItem>
          </AppMenu>
        </section>

        <section>
          <h2>AppPopover</h2>
          <p class="hint">
            Lower-level anchored bubble (component flavour). Caller owns
            visibility via <code>v-model:open</code>; AppPopover itself
            doesn't bake in click/hover detection. For the composable
            flavour see the avatar popover in the User tab.
          </p>
          <AppPopover v-model:open="popoverOpen">
            <template #trigger>
              <button type="button" class="anchor">
                {{ popoverOpen ? 'Close popover' : 'Open popover' }}
              </button>
            </template>
            <div class="pop-body">
              Popovers are the same primitive AppMenu builds on.<br />
              They flip + reposition automatically.
            </div>
          </AppPopover>
        </section>
      </div>

      <!-- ═════════════ Layout tab ═════════════ -->
      <div v-else-if="activeTab === 'layout'" class="tab-panel">
        <section>
          <h2>AppTabs (non-routed)</h2>
          <p class="hint">
            Plain button-based tabs. Use <code>AppTabsRouted</code> when you need
            URL-synced deep-linking; it lives behind a separate import path so
            plugin SPAs without <code>vue-router</code> don't pull it in.
            (This page itself uses AppTabs as its top-level navigator.)
          </p>
          <AppTabs
            v-model="innerTab"
            v-model:sub-model-value="subTab"
            :tabs="[{key:'first', label:'First'},{key:'second', label:'Second'}]"
            :sub-tabs="[{key:'a', label:'A'},{key:'b', label:'B'}]"
          >
            <div class="panel">
              Active: <code>{{ innerTab }}</code> / <code>{{ subTab }}</code>
            </div>
          </AppTabs>
        </section>

        <section>
          <h2>AppItemCard</h2>
          <p class="hint">
            Collapsible row card with an optional left accent stripe and
            three slots: <code>#leading</code> (drag handle / lock),
            <code>#title</code>, and <code>#trailing</code> (badges /
            toggles / menus). Body content lives in the default slot and
            only mounts while expanded.
          </p>
          <div class="item-card-list">
            <AppItemCard
              v-model:expanded="itemAOpen"
              accent-bar="accent"
              :disabled="!itemAEnabled"
            >
              <template #leading>
                <span class="leading-icon">⋮⋮</span>
              </template>
              <template #title>
                <span>Greet new members</span>
                <span class="trigger-summary">on member_join</span>
              </template>
              <template #trailing>
                <AppBadge size="sm" tone="accent" variant="outline" icon="material-symbols:bolt-outline-rounded">slash</AppBadge>
                <AppToggle v-model="itemAEnabled" aria-label="Enable greet" />
                <AppMenu placement="bottom-end">
                  <template #trigger>
                    <button type="button" class="menu-trigger">⋯</button>
                  </template>
                  <AppMenuItem icon="material-symbols:edit-outline-rounded">Edit</AppMenuItem>
                  <AppMenuItem danger icon="material-symbols:delete-outline-rounded">Delete</AppMenuItem>
                </AppMenu>
              </template>
              <p>Form fields, description, etc. — whatever the caller wants.</p>
            </AppItemCard>

            <AppItemCard
              v-model:expanded="itemBOpen"
              accent-bar="warn"
              :disabled="!itemBEnabled"
            >
              <template #title>
                <span>Disabled item (no leading slot)</span>
              </template>
              <template #trailing>
                <AppBadge size="sm" tone="warn" variant="outline">paused</AppBadge>
                <AppToggle v-model="itemBEnabled" aria-label="Enable item" />
              </template>
              <p>Body shows only when expanded.</p>
            </AppItemCard>
          </div>
        </section>
      </div>

      <!-- ═════════════ Display tab ═════════════ -->
      <div v-else-if="activeTab === 'display'" class="tab-panel">
        <section>
          <h2>AppBadge</h2>
          <p class="hint">
            Two axes: <code>tone</code> picks semantic colour (neutral /
            accent / success / warn / danger); <code>variant</code> picks
            style strength (soft / outline / solid). <code>size</code> is
            md (default) or sm. Mono mode for IDs / keys.
          </p>
          <div class="badge-matrix">
            <div class="badge-row">
              <strong>soft</strong>
              <AppBadge tone="neutral">neutral</AppBadge>
              <AppBadge tone="accent">accent</AppBadge>
              <AppBadge tone="success" icon="material-symbols:check-circle-outline-rounded">success</AppBadge>
              <AppBadge tone="warn" icon="material-symbols:warning-outline-rounded">warn</AppBadge>
              <AppBadge tone="danger" icon="material-symbols:error-outline-rounded">danger</AppBadge>
            </div>
            <div class="badge-row">
              <strong>outline</strong>
              <AppBadge variant="outline" tone="neutral">neutral</AppBadge>
              <AppBadge variant="outline" tone="accent">accent</AppBadge>
              <AppBadge variant="outline" tone="success">success</AppBadge>
              <AppBadge variant="outline" tone="warn">warn</AppBadge>
              <AppBadge variant="outline" tone="danger">danger</AppBadge>
            </div>
            <div class="badge-row">
              <strong>solid</strong>
              <AppBadge variant="solid" tone="neutral">neutral</AppBadge>
              <AppBadge variant="solid" tone="accent">accent</AppBadge>
              <AppBadge variant="solid" tone="success">success</AppBadge>
              <AppBadge variant="solid" tone="warn">warn</AppBadge>
              <AppBadge variant="solid" tone="danger">danger</AppBadge>
            </div>
            <div class="badge-row">
              <strong>sm / mono</strong>
              <AppBadge size="sm">sm tag</AppBadge>
              <AppBadge size="sm" tone="accent" icon="material-symbols:bolt-rounded">slash</AppBadge>
              <AppBadge mono tone="accent">karyl-example</AppBadge>
              <AppBadge mono size="sm">/ping</AppBadge>
            </div>
          </div>
        </section>

        <section>
          <h2>UnreadPill</h2>
          <p class="hint">Tiny count badge. Hidden at 0; capped at 99+.</p>
          <div class="pill-row">
            <span>Inbox <UnreadPill :count="3" /></span>
            <span>Mentions <UnreadPill :count="99" /></span>
            <span>Big <UnreadPill :count="9999" /></span>
            <span>Zero (hidden) <UnreadPill :count="0" /></span>
          </div>
        </section>
      </div>

      <!-- ═════════════ User tab ═════════════ -->
      <div v-else-if="activeTab === 'user'" class="tab-panel">
        <section v-if="meError" class="error-banner">
          <p class="result error">{{ meError }}</p>
        </section>
        <section v-else-if="me?.source === 'fallback'" class="warn-banner">
          <p class="result warn">
            ⚠ The bot can't see this user at all — neither members.get nor
            users.get returned a profile. Showing the userId as fallback.
          </p>
        </section>
        <section v-else-if="me?.source === 'global'" class="warn-banner">
          <p class="result warn">
            ⚠ No guild context (DM / private channel) — only users.get
            applied. Per-guild nickname / avatar overrides are unavailable
            here, but global profile (username, banner, accent) works.
          </p>
        </section>

        <section>
          <h2>UserAvatar</h2>
          <p class="hint">
            Circular avatar with letter-initial fallback. Real data is
            pulled from <code>/api/me</code>. The <code>animate</code>
            prop chooses when an animated avatar URL plays (always /
            hover / never) — Discord CDN swap is detected by the
            <code>a_</code> hash prefix, and <code>members.get</code>
            pre-bakes <code>?animated=true</code> for animated assets.
          </p>
          <div class="avatar-row">
            <UserAvatar :src="me?.avatarUrl ?? null" :name="me?.displayName ?? '?'" :size="40" animate="never" />
            <UserAvatar :src="me?.avatarUrl ?? null" :name="me?.displayName ?? '?'" :size="56" animate="hover" />
            <UserAvatar :src="me?.avatarUrl ?? null" :name="me?.displayName ?? '?'" :size="72" animate="always" />
            <UserAvatar :src="null" name="Letter Fallback" :size="40" />
            <UserAvatar :src="null" name="無名" :size="56" />
          </div>
          <p class="result">
            Three sizes of the viewer's own avatar (40/56/72 px). The two
            letter fallbacks demonstrate the no-src path with ASCII + CJK
            first-grapheme.
          </p>
        </section>

        <!-- ─── Avatar popover (composition: UserAvatar + usePopover + UserCard) ─── -->
        <section>
          <h2>Avatar popover (UserAvatar + usePopover + UserCard)</h2>
          <p class="hint">
            Composition demo — click the avatar to open a profile card.
            <code>usePopover</code> is the composable behind AppPopover;
            here it's wired directly so the trigger can be any element
            (the avatar button) and the popover content can be any
            element (a UserCard). Click outside / Escape close the
            popover automatically.
          </p>
          <div class="avatar-popover-demo">
            <button
              ref="avatarTriggerRef"
              type="button"
              class="avatar-trigger"
              :class="{ 'avatar-trigger--active': avatarPopoverOpen }"
              :aria-expanded="avatarPopoverOpen"
              aria-haspopup="dialog"
              :aria-label="me ? `View ${me.displayName}` : 'View profile'"
            >
              <UserAvatar
                :src="me?.avatarUrl ?? null"
                :name="me?.displayName ?? '?'"
                :size="56"
                animate="hover"
              />
            </button>
            <span class="muted">← Click the avatar</span>
          </div>
          <!-- Popover content. The element is teleported to <body> by
               usePopover (teleportTo:'body') so z-index / overflow on
               the surrounding section can't clip it. -->
          <div ref="avatarPopoverRef" class="avatar-popover">
            <UserCard
              v-if="me"
              :name="me.displayName"
              :nickname="me.nickname"
              :username="me.username"
              :avatar-url="me.avatarUrl"
              :banner-url="me.bannerUrl"
              :accent-color="me.accentColor"
              :is-bot="me.isBot"
            >
              <template #facts>
                <dl class="facts">
                  <dt>User ID</dt>
                  <dd><code>{{ me.userId }}</code></dd>
                  <dt v-if="me.guildId">Guild</dt>
                  <dd v-if="me.guildId"><code>{{ me.guildId }}</code></dd>
                </dl>
              </template>
              <template #actions>
                <AppButton variant="ghost" size="sm" @click="toast.show(me!.userId, 'info')">
                  Copy User ID
                </AppButton>
              </template>
            </UserCard>
            <UserCard v-else name="Loading…" loading />
          </div>
        </section>

        <section>
          <h2>UserItem</h2>
          <p class="hint">
            Compact row with avatar, primary + secondary text, and a
            <code>#trailing</code> slot for timestamps / unread counts /
            actions. Avatar defaults to hover-animation.
          </p>
          <div class="userlist">
            <UserItem
              v-if="me"
              :name="me.displayName"
              :subtitle="`Discord ID: ${me.userId}`"
              :avatar-url="me.avatarUrl"
              interactive
              active
              @click="toast.show('You are already this user', 'info')"
            >
              <template #trailing>
                <UnreadPill :count="0" />
              </template>
            </UserItem>
            <UserItem
              v-else
              name="Loading…"
              subtitle="fetching /api/me"
              :avatar-url="null"
            />
            <UserItem
              name="Synthetic peer"
              subtitle="@another_user · placeholder row"
              :avatar-url="null"
              interactive
              @click="toast.show('Selected peer', 'info')"
            >
              <template #trailing>
                <span class="muted">2m</span>
              </template>
            </UserItem>
            <UserItem
              name="Disabled row"
              subtitle="cannot interact"
              :avatar-url="null"
              interactive
              disabled
            />
          </div>
        </section>

        <section>
          <h2>UserCard</h2>
          <p class="hint">
            Profile card hydrated from <code>/api/me</code>. Fields layer:
            <code>members.get</code> supplies the guild nickname + avatar
            override (when there's a guild), <code>users.get</code> fills
            the global profile. Second card shows the loading skeleton
            state.
          </p>
          <div class="card-row">
            <UserCard
              v-if="me"
              :name="me.displayName"
              :nickname="me.nickname"
              :username="me.username"
              :avatar-url="me.avatarUrl"
              :banner-url="me.bannerUrl"
              :accent-color="me.accentColor"
              :is-bot="me.isBot"
            >
              <template #facts>
                <dl class="facts">
                  <dt>User ID</dt>
                  <dd><code>{{ me.userId }}</code></dd>
                  <dt v-if="me.guildId">Guild</dt>
                  <dd v-if="me.guildId"><code>{{ me.guildId }}</code></dd>
                  <dt>Source</dt>
                  <dd>{{ me.source }}</dd>
                </dl>
              </template>
              <template #actions>
                <AppButton variant="ghost" size="sm" @click="toast.show(me!.userId, 'info')">
                  Copy User ID
                </AppButton>
              </template>
            </UserCard>
            <UserCard v-else name="Loading…" loading />
            <UserCard name="Loading…" loading />
          </div>
        </section>
      </div>

      <!-- ═════════════ Misc tab ═════════════ -->
      <div v-else-if="activeTab === 'misc'" class="tab-panel">
        <section>
          <h2>Draggable</h2>
          <p class="hint">
            Makes a single element user-draggable within a bounding box.
            The bot frontend uses it for the mobile FAB. Try dragging
            the chip around inside the dotted box below.
          </p>
          <div ref="dragBoundsRef" class="drag-bounds">
            <Draggable :bounds="dragBoundsRef" :boundary-padding="6">
              <div class="drag-chip">Drag me</div>
            </Draggable>
          </div>
        </section>
      </div>
    </AppTabs>
  </div>
</template>

<style scoped>
.showcase {
  max-width: 920px;
  margin: 0 auto;
  padding: 1.5rem 1rem;
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
}

/* ── Page header ────────────────────────────────────────────────── */
.page-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
  flex-wrap: wrap;
}
.page-header__text { display: flex; flex-direction: column; gap: 0.3rem; }
.page-header h1 { margin: 0; color: var(--text-strong); }
.lede { margin: 0; color: var(--text-muted); }
.theme-picker {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  min-width: 180px;
}
.theme-picker-label {
  font-size: 0.8rem;
  color: var(--text-muted);
}

/* ── Tab body ───────────────────────────────────────────────────── */
.tab-panel {
  padding: 1.25rem 0 0.5rem;
  display: flex;
  flex-direction: column;
  gap: 1.75rem;
}

/* ── Section ─────────────────────────────────────────────────────
   Each section is a flex column so consecutive rows / grids stop
   touching each other (the old layout had multiple .row divs in the
   same section without any vertical gap).
   `align-items: flex-start` keeps bare triggers (AppButton / AppMenu's
   button / AppPopover's button / the avatar trigger) sized to their
   own content instead of being stretched to the full section width.
   The layout containers below opt back into full width via
   `align-self: stretch` so multi-item rows still wrap correctly. */
section {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 0.7rem;
}
section > h2,
section > p,
section > .row,
section > .form-grid,
section > .toggle-grid,
section > .badge-matrix,
section > .pill-row,
section > .item-card-list,
section > .userlist,
section > .card-row,
section > .drag-bounds,
section > .avatar-row,
section > .avatar-popover-demo,
section > .field {
  align-self: stretch;
}
section h2 {
  margin: 0;
  color: var(--text-strong);
  font-size: 1.1rem;
  border-bottom: 1px solid var(--border);
  padding-bottom: 0.35rem;
}
.hint {
  color: var(--text-muted);
  font-size: 0.85rem;
  margin: 0;
  line-height: 1.55;
}
.hint code,
.result code,
.facts code {
  background: var(--code-bg);
  padding: 0 0.25rem;
  border-radius: 3px;
  font-size: 0.9em;
}
.result { color: var(--text-muted); font-size: 0.85rem; margin: 0; }
.result.error { color: var(--danger); }
.result.warn {
  color: var(--warn-text);
  background: var(--warn-bg);
  border-radius: var(--radius-sm);
  padding: 0.4rem 0.6rem;
}
.error-banner,
.warn-banner { gap: 0; }
.muted { color: var(--text-muted); font-size: 0.85rem; }

/* ── Rows / grids ───────────────────────────────────────────────── */
.row {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  align-items: center;
}
.pill-row {
  display: flex;
  flex-wrap: wrap;
  gap: 0.9rem;
  align-items: center;
  font-size: 0.85rem;
}
.toggle-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
  gap: 0.5rem 1rem;
}
.toggle-cell {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.85rem;
}
.toggle-cell code {
  background: var(--code-bg);
  padding: 0 0.25rem;
  border-radius: 3px;
  font-size: 0.85em;
}
.form-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.8rem;
}
@media (max-width: 540px) {
  .form-grid { grid-template-columns: 1fr; }
}
.badge-matrix {
  display: flex;
  flex-direction: column;
  gap: 0.55rem;
}
.badge-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.45rem;
}
.badge-row strong {
  min-width: 72px;
  color: var(--text-muted);
  font-size: 0.78rem;
  font-weight: 600;
}

/* ── Triggers / anchors ─────────────────────────────────────────── */
.anchor {
  background: var(--bg-surface);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: var(--radius-base);
  padding: 0.4rem 0.8rem;
  cursor: pointer;
  font: inherit;
  font-size: 0.85rem;
}
.anchor:hover { background: var(--bg-surface-hover); }

/* ── Modal / popover bodies ─────────────────────────────────────── */
.modal-body {
  display: flex;
  flex-direction: column;
  gap: 0.7rem;
  color: var(--text);
  font-size: 0.9rem;
}
.pop-body {
  padding: 0.5rem 0.7rem;
  font-size: 0.85rem;
  color: var(--text);
}

/* ── SelectField wrapper (label + control) ───────────────────────── */
.field {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
  max-width: 320px;
}
.field label {
  font-size: 0.8rem;
  color: var(--text-muted);
}

/* ── AppSelect custom list ──────────────────────────────────────── */
.custom-list {
  list-style: none;
  margin: 0;
  padding: 0.3rem 0;
  min-width: 180px;
}
.custom-list li {
  padding: 0.4rem 0.85rem;
  cursor: pointer;
}
.custom-list li:hover { background: var(--bg-surface-hover); }

/* ── Tabs demo panel ────────────────────────────────────────────── */
.panel {
  padding: 0.7rem 0;
  color: var(--text);
}

/* ── User-tab layout ────────────────────────────────────────────── */
.avatar-row {
  display: flex;
  flex-wrap: wrap;
  gap: 0.6rem;
  align-items: center;
}
.userlist {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  max-width: 360px;
  border: 1px solid var(--border);
  border-radius: var(--radius-base);
  padding: 0.3rem;
  background: var(--bg-surface);
}
.card-row {
  display: flex;
  flex-wrap: wrap;
  gap: 0.6rem;
}

/* ── Avatar popover demo ────────────────────────────────────────── */
.avatar-popover-demo {
  display: flex;
  align-items: center;
  gap: 0.6rem;
}
.avatar-trigger {
  /* inline-flex + line-height: 0 — without these, the surrounding
     button has baseline descender space below the avatar, which
     stretches the round border into an oval when active. */
  display: inline-flex;
  line-height: 0;
  background: none;
  border: 2px solid transparent;
  border-radius: 50%;
  padding: 2px;
  cursor: pointer;
  transition: border-color var(--transition-fast, 0.12s),
              transform var(--transition-fast, 0.12s);
}
.avatar-trigger:hover { border-color: var(--border-strong); }
.avatar-trigger:focus-visible {
  outline: none;
  border-color: var(--accent);
}
.avatar-trigger--active {
  border-color: var(--accent);
  transform: scale(0.96);
}
.avatar-popover {
  /* usePopover toggles display:none/block; this rule is only for the
     wrapper card chrome (the popover element gets teleported to body). */
  background: transparent;
  /* Subtle drop-shadow so the floating card has depth against any
     background it lands over. */
  filter: drop-shadow(0 6px 18px rgba(0, 0, 0, 0.18));
}

.facts {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 0.25rem 0.6rem;
  margin: 0;
  font-size: 0.82rem;
}
.facts dt {
  color: var(--text-muted);
  align-self: baseline;
}
.facts dd {
  margin: 0;
  min-width: 0;
}
.facts code {
  font-size: 0.78rem;
  word-break: break-all;
}

/* ── Item-card-list ─────────────────────────────────────────────── */
.item-card-list { display: flex; flex-direction: column; gap: 0.5rem; }
.leading-icon {
  display: inline-flex;
  width: 18px;
  justify-content: center;
  color: var(--text-muted);
  cursor: grab;
  user-select: none;
}
.trigger-summary { color: var(--text-muted); font-size: 0.85rem; }
.menu-trigger {
  background: none;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  font-size: 1.1rem;
  padding: 0 0.25rem;
}
.menu-trigger:hover { color: var(--text); }

/* ── Draggable demo ─────────────────────────────────────────────── */
.drag-bounds {
  position: relative;
  height: 220px;
  border: 1px dashed var(--border-strong);
  border-radius: var(--radius-base);
  background: var(--bg-surface-2);
}
.drag-chip {
  display: inline-flex;
  align-items: center;
  padding: 0.4rem 0.8rem;
  background: var(--accent);
  color: var(--text-on-accent);
  border-radius: var(--radius-pill);
  font-size: 0.85rem;
  cursor: grab;
  user-select: none;
}
.drag-chip:active { cursor: grabbing; }
</style>

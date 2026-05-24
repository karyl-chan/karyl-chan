<script setup lang="ts">
/**
 * ShowcaseView — every @karyl-chan/ui component on one page.
 *
 * Acts both as a visual catalog and as a smoke test that the package's
 * tree-shaking + side-effect-free imports work end-to-end. Each section
 * triggers the component in a few representative configurations.
 *
 * AppTabsRouted is intentionally NOT shown — pulling it in would force
 * `vue-router` into this plugin's bundle and defeat the point of the
 * Base/Routed split. There's a note in the AppTabs section.
 */
import { ref } from "vue";
import {
  AppButton,
  AppConfirmDialog,
  AppMenu,
  AppMenuItem,
  AppModal,
  AppPopover,
  AppSelect,
  AppSelectField,
  AppTabs,
  Draggable,
  UnreadPill,
  useConfirm,
  useToastStore,
} from "@karyl-chan/ui";

const toast = useToastStore();
const { confirm } = useConfirm();

// Modal demo
const modalOpen = ref(false);

// Inline AppConfirmDialog (not the global flavour)
const inlineConfirmOpen = ref(false);
const inlineLoading = ref(false);

// Popover demo — slot-driven, with explicit v-model:open so the caller
// owns visibility (AppPopover deliberately doesn't bake in
// hover/click trigger detection — the slot's click handler does).
const popoverOpen = ref(false);

// Select demo
const selectOpen = ref(false);
const selectValue = ref<string>("alpha");
const selectOptions = [
  { value: "alpha", label: "Alpha" },
  { value: "beta", label: "Beta" },
  { value: "gamma", label: "Gamma", group: "Greeks" },
  { value: "delta", label: "Delta", group: "Greeks" },
];

// SelectField (form-input-shaped Select)
const fieldValue = ref<string>("");

// Tabs demo
const tab = ref("first");
const subTab = ref("a");

// Draggable demo — single draggable element constrained to its parent.
const dragBoundsRef = ref<HTMLElement | null>(null);

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

async function inlineConfirm() {
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
    <header>
      <h1>@karyl-chan/ui Showcase</h1>
      <p class="lede">
        Every component, with a few representative configurations.
      </p>
    </header>

    <section>
      <h2>AppButton</h2>
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
        Lower-level anchored bubble. Caller controls visibility via
        <code>v-model:open</code>; AppPopover itself doesn't bake in
        click/hover detection (deliberate — different surfaces want
        different triggers).
      </p>
      <AppPopover v-model:open="popoverOpen">
        <template #trigger>
          <!-- The trigger slot's wrapper handles click → toggle internally.
               Don't add another click handler here or it'll double-toggle
               (open → bubble → close on the same click). -->
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

    <section>
      <h2>AppSelect (raw)</h2>
      <p class="hint">
        Headless dropdown. Most callers will want AppSelectField instead — but
        AppSelect is here for custom triggers / lists.
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

    <section>
      <h2>AppSelectField (form-input)</h2>
      <p class="hint">Drop-in replacement for native <code>&lt;select&gt;</code>.</p>
      <div class="field">
        <label>Greek letter</label>
        <AppSelectField v-model="fieldValue" :options="selectOptions" placeholder="Pick one" filter />
      </div>
      <p class="result">Value: <code>{{ fieldValue || "(none)" }}</code></p>
    </section>

    <section>
      <h2>AppTabs (non-routed)</h2>
      <p class="hint">
        Plain button-based tabs. Use <code>AppTabsRouted</code> when you need
        URL-synced deep-linking; it lives behind a separate import path so
        plugin SPAs without <code>vue-router</code> don't pull it in.
      </p>
      <AppTabs
        v-model="tab"
        v-model:sub-model-value="subTab"
        :tabs="[{key:'first', label:'First'},{key:'second', label:'Second'}]"
        :sub-tabs="[{key:'a', label:'A'},{key:'b', label:'B'}]"
      >
        <div class="panel">
          Active: <code>{{ tab }}</code> / <code>{{ subTab }}</code>
        </div>
      </AppTabs>
    </section>

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

    <section>
      <h2>UnreadPill</h2>
      <p class="hint">Tiny count badge.</p>
      <div class="row" style="align-items:center;">
        <span>Inbox <UnreadPill :count="3" /></span>
        <span>Mentions <UnreadPill :count="99" /></span>
        <span>Big <UnreadPill :count="9999" /></span>
        <span>Zero (hidden) <UnreadPill :count="0" /></span>
      </div>
    </section>
  </div>
</template>

<style scoped>
.showcase {
  max-width: 920px;
  margin: 0 auto;
  padding: 1.5rem 1rem;
  display: flex;
  flex-direction: column;
  gap: 2rem;
}
header h1 { margin: 0; color: var(--text-strong); }
.lede { margin: 0.3rem 0 0; color: var(--text-muted); }

section h2 {
  margin: 0 0 0.4rem;
  color: var(--text-strong);
  font-size: 1.15rem;
  border-bottom: 1px solid var(--border);
  padding-bottom: 0.3rem;
}
.hint {
  color: var(--text-muted);
  font-size: 0.85rem;
  margin: 0 0 0.7rem;
}
.hint code, .result code {
  background: var(--code-bg);
  padding: 0 0.25rem;
  border-radius: 3px;
  font-size: 0.9em;
}
.result { color: var(--text-muted); font-size: 0.85rem; margin-top: 0.4rem; }

.row {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  align-items: flex-start;
}

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

.modal-body {
  padding: 0.8rem 1rem 0.6rem;
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

.panel {
  padding: 0.7rem 0;
  color: var(--text);
}
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

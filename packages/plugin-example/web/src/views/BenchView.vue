<script setup lang="ts">
/**
 * BenchView — stress + boundary patterns.
 *
 *  1. Big list render — show N rows, measure frame time around the
 *     mutation. N is user-controlled via the input box.
 *  2. Multiple concurrent modals/popovers — open several anchored
 *     overlays at once to confirm escape-stack / click-outside-stack
 *     don't interfere with each other.
 *  3. Large Draggable — drag a list of 50 items to verify pointer
 *     handlers don't choke.
 */
import { computed, nextTick, ref } from "vue";
import {
  AppButton,
  AppModal,
  AppPopover,
  Draggable,
  useToastStore,
} from "@karyl-chan/ui";

const toast = useToastStore();

// ── Big list ─────────────────────────────────────────────────────────
const targetCount = ref(1000);
const rows = ref<number[]>([]);
const renderMs = ref<number | null>(null);

async function generate() {
  const n = Math.max(0, Math.min(20000, targetCount.value | 0));
  const start = performance.now();
  rows.value = Array.from({ length: n }, (_, i) => i + 1);
  await nextTick();
  renderMs.value = performance.now() - start;
}

// ── Concurrent overlays ──────────────────────────────────────────────
const modalA = ref(false);
const modalB = ref(false);
const popTriggerA = ref<HTMLElement | null>(null);
const popTriggerB = ref<HTMLElement | null>(null);

// ── Draggable ────────────────────────────────────────────────────────
const dragBoundsRef = ref<HTMLElement | null>(null);
const dragChips = ref(Array.from({ length: 12 }, (_, i) => i + 1));

const renderSummary = computed(() =>
  renderMs.value === null ? "—" : `${rows.value.length} rows in ${renderMs.value.toFixed(1)} ms`,
);
</script>

<template>
  <div class="bench">
    <header>
      <h1>Bench</h1>
      <p class="lede">
        Heavy-render and overlay-stress patterns to confirm the UI package
        behaves under load. Not real perf testing — eyeball + frame time.
      </p>
    </header>

    <section>
      <h2>Big list render</h2>
      <div class="controls">
        <label>
          Row count
          <input v-model.number="targetCount" type="number" min="0" max="20000" />
        </label>
        <AppButton variant="primary" @click="generate">Generate &amp; measure</AppButton>
        <span class="result">{{ renderSummary }}</span>
      </div>
      <ul class="rows">
        <li v-for="n in rows" :key="n">Row {{ n }}</li>
      </ul>
    </section>

    <section>
      <h2>Concurrent overlays</h2>
      <p class="hint">
        Open multiple modals + popovers. Escape closes the topmost; click outside
        a popover closes only that one. Hit them in sequence to verify the
        escape-stack / click-outside-stack ordering.
      </p>
      <div class="row">
        <AppButton @click="modalA = true">Open modal A</AppButton>
        <AppButton @click="modalB = true">Open modal B</AppButton>
        <button ref="popTriggerA" type="button" class="anchor">Popover A</button>
        <button ref="popTriggerB" type="button" class="anchor">Popover B</button>
      </div>
      <AppModal :visible="modalA" title="Modal A" @close="modalA = false">
        <div class="modal-body">
          Open modal B underneath, then press Escape — only this one (the topmost) closes.
          <AppButton variant="ghost" @click="modalA = false">Close A</AppButton>
        </div>
      </AppModal>
      <AppModal :visible="modalB" title="Modal B" @close="modalB = false">
        <div class="modal-body">
          Modal B body.
          <AppButton variant="ghost" @click="modalB = false">Close B</AppButton>
        </div>
      </AppModal>
      <AppPopover v-if="popTriggerA" :reference="popTriggerA" trigger="click">
        <div class="pop-body">Popover A — click outside to close.</div>
      </AppPopover>
      <AppPopover v-if="popTriggerB" :reference="popTriggerB" trigger="click">
        <div class="pop-body">Popover B.</div>
      </AppPopover>
    </section>

    <section>
      <h2>Concurrent Draggables (12 chips)</h2>
      <p class="hint">
        Twelve independent Draggable elements sharing one bounds element.
        Pointer-capture / boundary clamping should not interfere across
        instances.
      </p>
      <div ref="dragBoundsRef" class="drag-bounds">
        <Draggable
          v-for="n in dragChips"
          :key="n"
          :bounds="dragBoundsRef"
          :boundary-padding="4"
          class="bench-chip-wrap"
        >
          <div class="bench-chip">{{ n }}</div>
        </Draggable>
      </div>
      <p class="result">
        <AppButton size="sm" variant="ghost" @click="toast.show('All chips intact', 'info')">
          Toast
        </AppButton>
      </p>
    </section>
  </div>
</template>

<style scoped>
.bench {
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
  font-size: 1.1rem;
  color: var(--text-strong);
  border-bottom: 1px solid var(--border);
  padding-bottom: 0.3rem;
}
.hint { color: var(--text-muted); font-size: 0.85rem; margin: 0 0 0.6rem; }
.controls {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  margin-bottom: 0.6rem;
  flex-wrap: wrap;
}
.controls label {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  font-size: 0.85rem;
  color: var(--text-muted);
}
.controls input {
  padding: 0.3rem 0.45rem;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-surface);
  color: var(--text);
  width: 90px;
  font: inherit;
  font-size: 0.9rem;
}
.result { color: var(--text-muted); font-size: 0.85rem; }

.rows {
  list-style: none;
  margin: 0;
  padding: 0;
  max-height: 320px;
  overflow-y: auto;
  border: 1px solid var(--border);
  border-radius: var(--radius-base);
  background: var(--bg-surface);
}
.rows li {
  padding: 0.25rem 0.6rem;
  border-bottom: 1px solid var(--border);
  font-size: 0.85rem;
}
.rows li:last-child { border-bottom: none; }

.row {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
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
.modal-body {
  padding: 0.8rem 1rem;
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
  color: var(--text);
  font-size: 0.9rem;
}
.pop-body {
  padding: 0.5rem 0.7rem;
  font-size: 0.85rem;
  color: var(--text);
}
.drag-bounds {
  position: relative;
  height: 280px;
  border: 1px dashed var(--border-strong);
  border-radius: var(--radius-base);
  background: var(--bg-surface-2);
  overflow: hidden;
}
.bench-chip-wrap { position: absolute; }
.bench-chip {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 38px;
  height: 38px;
  background: var(--accent);
  color: var(--text-on-accent);
  border-radius: var(--radius-pill);
  font-size: 0.85rem;
  font-weight: 600;
  cursor: grab;
  user-select: none;
}
.bench-chip:active { cursor: grabbing; }
</style>

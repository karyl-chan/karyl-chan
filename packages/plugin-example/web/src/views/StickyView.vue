<script setup lang="ts">
/**
 * StickyView — user-bound WebUI ↔ persisted KV.
 *
 * Demonstrates the simplest "webui talks to bot, bot persists state"
 * pattern: a single text area whose body is autosaved to the plugin's
 * SQLite store, keyed on (guildId, userId). The same row is readable
 * from Discord via the slash command (separate feature, not wired
 * here).
 */
import { onMounted, ref, watch } from "vue";
import { AppButton, useToastStore } from "@karyl-chan/ui";
import { getSticky, saveSticky, deleteSticky } from "../api";

const body = ref("");
const lastSaved = ref<number>(0);
const status = ref<"idle" | "saving" | "saved" | "error">("idle");
const errorMsg = ref<string | null>(null);
const toast = useToastStore();

const SAVE_DEBOUNCE_MS = 800;
let saveTimer: number | null = null;
let saveSeq = 0;

onMounted(async () => {
  try {
    const r = await getSticky();
    body.value = r.sticky.body;
    lastSaved.value = r.sticky.updated;
    status.value = r.sticky.updated > 0 ? "saved" : "idle";
  } catch (err) {
    errorMsg.value = err instanceof Error ? err.message : "Failed to load";
    status.value = "error";
  }
});

async function doSave(text: string) {
  status.value = "saving";
  const mySeq = ++saveSeq;
  try {
    const r = await saveSticky(text);
    if (mySeq !== saveSeq) return; // a newer save has been issued
    lastSaved.value = r.sticky.updated;
    status.value = "saved";
    errorMsg.value = null;
  } catch (err) {
    if (mySeq !== saveSeq) return;
    status.value = "error";
    errorMsg.value = err instanceof Error ? err.message : "Save failed";
    toast.show("Failed to save note", "error");
  }
}

watch(body, (next) => {
  if (saveTimer !== null) window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    saveTimer = null;
    void doSave(next);
  }, SAVE_DEBOUNCE_MS);
});

async function clearNote() {
  if (!body.value) return;
  try {
    await deleteSticky();
    body.value = "";
    lastSaved.value = 0;
    status.value = "idle";
    toast.show("Note cleared", "info");
  } catch (err) {
    toast.show(err instanceof Error ? err.message : "Clear failed", "error");
  }
}

function fmt(ts: number): string {
  if (!ts) return "never";
  const d = new Date(ts);
  return d.toLocaleString();
}
</script>

<template>
  <div class="sticky-view">
    <header class="header">
      <h2>Your sticky note</h2>
      <p class="hint">
        Anything you type here is autosaved to this server's plugin
        storage and tied to your Discord account. It's not shared with
        other users — but admins can see all notes in
        <code>/example-manage</code>.
      </p>
    </header>
    <textarea
      v-model="body"
      class="note"
      rows="14"
      placeholder="Start typing — saves automatically after a short pause."
    />
    <footer class="footer">
      <span class="status" :class="`status--${status}`">
        <template v-if="status === 'idle'">Not saved yet</template>
        <template v-else-if="status === 'saving'">Saving…</template>
        <template v-else-if="status === 'saved'">Saved · {{ fmt(lastSaved) }}</template>
        <template v-else>Error · {{ errorMsg }}</template>
      </span>
      <AppButton
        variant="ghost"
        size="sm"
        :disabled="!body"
        @click="clearNote"
      >
        Clear
      </AppButton>
    </footer>
  </div>
</template>

<style scoped>
.sticky-view {
  max-width: 720px;
  margin: 1.5rem auto;
  padding: 0 1rem;
  display: flex;
  flex-direction: column;
  gap: 0.8rem;
}
.header h2 {
  margin: 0 0 0.3rem;
  color: var(--text-strong);
}
.hint {
  margin: 0;
  color: var(--text-muted);
  font-size: 0.85rem;
}
.hint code {
  background: var(--code-bg);
  padding: 0 0.25rem;
  border-radius: 3px;
  font-size: 0.85em;
}
.note {
  width: 100%;
  resize: vertical;
  padding: 0.75rem;
  border: 1px solid var(--border);
  border-radius: var(--radius-base);
  background: var(--bg-surface);
  color: var(--text);
  font-family: inherit;
  font-size: 0.95rem;
  line-height: 1.55;
}
.note:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}
.footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.6rem;
  font-size: 0.85rem;
}
.status--idle,
.status--saving { color: var(--text-muted); }
.status--saved { color: var(--success-text); }
.status--error { color: var(--danger); }
</style>

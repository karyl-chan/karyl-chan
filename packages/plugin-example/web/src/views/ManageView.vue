<script setup lang="ts">
/**
 * ManageView — admin-only overview of all sticky notes in the guild.
 *
 * Shows the full list as a table with userId / last-updated /
 * content preview. Refresh button re-fetches; deletion (per-user) is
 * not wired in this demo to keep the surface read-only — admins use
 * Discord's own UI to talk to users about their notes.
 */
import { onMounted, ref } from "vue";
import { AppButton, useToastStore } from "@karyl-chan/ui";
import { listStickies, type StickyRow } from "../api";

const props = defineProps<{ guildId: string }>();

const rows = ref<StickyRow[]>([]);
const loading = ref(false);
const toast = useToastStore();

async function refresh(): Promise<void> {
  if (!props.guildId) return;
  loading.value = true;
  try {
    const r = await listStickies(props.guildId);
    rows.value = r.stickies;
  } catch (err) {
    toast.show(err instanceof Error ? err.message : "Load failed", "error");
  } finally {
    loading.value = false;
  }
}

onMounted(refresh);

function fmt(ts: number): string {
  return ts ? new Date(ts).toLocaleString() : "—";
}
</script>

<template>
  <div class="manage">
    <header class="head">
      <h2>Sticky notes — guild <code>{{ guildId || "(unknown)" }}</code></h2>
      <AppButton size="sm" variant="ghost" :loading="loading" @click="refresh">
        Refresh
      </AppButton>
    </header>
    <p class="hint">
      Read-only audit view of every user's <code>/example-sticky</code>
      note in this guild. Sorted by most-recently-updated.
    </p>
    <table v-if="rows.length" class="rows">
      <thead>
        <tr>
          <th>User</th>
          <th>Updated</th>
          <th>Preview</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="row.userId">
          <td><code>{{ row.userId }}</code></td>
          <td>{{ fmt(row.updated) }}</td>
          <td class="preview">{{ row.body.slice(0, 120) || "(empty)" }}</td>
        </tr>
      </tbody>
    </table>
    <p v-else-if="!loading" class="empty">
      No sticky notes yet in this guild.
    </p>
  </div>
</template>

<style scoped>
.manage {
  max-width: 920px;
  margin: 1.5rem auto;
  padding: 0 1rem;
}
.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  margin-bottom: 0.3rem;
}
.head h2 { margin: 0; color: var(--text-strong); }
.head code {
  font-size: 0.85em;
  color: var(--text-muted);
}
.hint {
  color: var(--text-muted);
  margin: 0 0 1rem;
  font-size: 0.85rem;
}
.hint code {
  background: var(--code-bg);
  padding: 0 0.25rem;
  border-radius: 3px;
  font-size: 0.9em;
}
.rows {
  width: 100%;
  border-collapse: collapse;
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-base);
  overflow: hidden;
}
.rows th, .rows td {
  text-align: left;
  padding: 0.5rem 0.75rem;
  border-bottom: 1px solid var(--border);
  font-size: 0.88rem;
  vertical-align: top;
}
.rows tbody tr:last-child td { border-bottom: none; }
.rows th {
  color: var(--text-muted);
  font-weight: 500;
  font-size: 0.78rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
.rows code {
  font-family: ui-monospace, monospace;
  font-size: 0.85em;
}
.preview {
  white-space: pre-wrap;
  color: var(--text);
  max-width: 480px;
}
.empty {
  padding: 2rem 0;
  color: var(--text-muted);
  text-align: center;
}
</style>

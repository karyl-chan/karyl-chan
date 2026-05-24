<script setup lang="ts">
/**
 * ChatView — bidirectional sync demo.
 *
 *  Discord channel ↔  plugin server  ↔  WebUI
 *
 * - Webui submits messages → POST /api/chat/send → plugin calls
 *   bot RPC messages.send (Discord shows the message) → plugin fans out
 *   a ChatEvent to all SSE subscribers (the same tab sees its own echo,
 *   plus any other open tabs).
 * - Discord users send messages in the same channel → bot dispatches
 *   MESSAGE_CREATE to the plugin's /events route → plugin fans out a
 *   ChatEvent. Webui SPA receives it via SSE and appends to history.
 *
 * On SSE error after 4 retries the channel falls back to an
 * EventSource-less state and posts the SDK's onGiveUp hook — we surface
 * the disconnection via a tag at the top of the view.
 */
import { computed, nextTick, onMounted, onUnmounted, ref } from "vue";
import { AppButton, useToastStore } from "@karyl-chan/ui";
import {
  fetchChatHistory,
  openChatSse,
  sendChat,
  type ChatEvent,
} from "../api";
import type { SseChannel } from "@karyl-chan/plugin-sdk/web";

const props = defineProps<{ channelId: string }>();

const toast = useToastStore();
const events = ref<ChatEvent[]>([]);
const input = ref("");
const sending = ref(false);
const connected = ref(false);
const listRef = ref<HTMLElement | null>(null);
let sse: SseChannel | null = null;

function append(event: ChatEvent): void {
  // De-dupe: the local fan-out sends our own webui message back to
  // us; the local send code already pushed it into `events`. Match
  // by (source, authorId, ts) — coarse but enough for echo
  // suppression in this demo.
  const last = events.value[events.value.length - 1];
  if (last && last.ts === event.ts && last.source === event.source && last.authorId === event.authorId) {
    return;
  }
  events.value.push(event);
  void nextTick(() => {
    listRef.value?.scrollTo({
      top: listRef.value.scrollHeight,
      behavior: "smooth",
    });
  });
}

onMounted(async () => {
  try {
    const r = await fetchChatHistory(props.channelId);
    events.value = r.events;
  } catch (err) {
    toast.show(err instanceof Error ? err.message : "Failed to load history", "error");
  }
  sse = openChatSse(
    props.channelId,
    (event) => {
      connected.value = true;
      append(event);
    },
    () => {
      connected.value = false;
      toast.show("Lost connection to chat stream", "error");
    },
  );
});

onUnmounted(() => {
  sse?.stop();
});

const canSend = computed(() => !sending.value && input.value.trim().length > 0);

async function send(): Promise<void> {
  const text = input.value.trim();
  if (!text) return;
  sending.value = true;
  try {
    const r = await sendChat(props.channelId, text);
    // Echo to ourselves so the UI feels instant. The fan-out from
    // the server will arrive shortly and be de-duped by `append`.
    append(r.event);
    input.value = "";
  } catch (err) {
    toast.show(err instanceof Error ? err.message : "Send failed", "error");
  } finally {
    sending.value = false;
  }
}

function onKey(e: KeyboardEvent): void {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    void send();
  }
}

function fmtTs(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
</script>

<template>
  <div class="chat">
    <header class="head">
      <span class="title">Channel <code>{{ channelId }}</code></span>
      <span :class="['conn', connected ? 'conn--up' : 'conn--down']">
        {{ connected ? "● live" : "○ offline" }}
      </span>
    </header>
    <ul ref="listRef" class="messages">
      <li v-if="!events.length" class="empty">
        No messages yet — send something or wait for Discord traffic.
      </li>
      <li
        v-for="event in events"
        :key="`${event.ts}-${event.authorId}-${event.content.slice(0, 4)}`"
        :class="['msg', `msg--${event.source}`]"
      >
        <div class="msg-meta">
          <strong>{{ event.authorName }}</strong>
          <span class="msg-source">{{ event.source }}</span>
          <span class="msg-ts">{{ fmtTs(event.ts) }}</span>
        </div>
        <div class="msg-body">{{ event.content }}</div>
      </li>
    </ul>
    <footer class="composer">
      <textarea
        v-model="input"
        :disabled="sending"
        rows="2"
        placeholder="Type a message (Enter to send, Shift+Enter for newline)…"
        @keydown="onKey"
      />
      <AppButton
        variant="primary"
        :loading="sending"
        :disabled="!canSend"
        @click="send"
      >
        Send
      </AppButton>
    </footer>
  </div>
</template>

<style scoped>
.chat {
  display: flex;
  flex-direction: column;
  height: 100%;
  max-width: 800px;
  margin: 0 auto;
  padding: 0 1rem 1rem;
}
.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.6rem 0;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}
.title {
  color: var(--text);
  font-weight: 500;
}
.title code {
  font-family: ui-monospace, monospace;
  font-size: 0.85em;
  color: var(--text-muted);
}
.conn--up { color: var(--success-text); }
.conn--down { color: var(--text-muted); }

.messages {
  list-style: none;
  margin: 0;
  padding: 0.6rem 0;
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.empty {
  color: var(--text-muted);
  text-align: center;
  padding: 2rem 0;
}
.msg {
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-base);
  padding: 0.5rem 0.7rem;
}
.msg--webui { border-left: 3px solid var(--accent); }
.msg--discord { border-left: 3px solid var(--success-text); }

.msg-meta {
  display: flex;
  align-items: baseline;
  gap: 0.4rem;
  font-size: 0.78rem;
  color: var(--text-muted);
  margin-bottom: 0.15rem;
}
.msg-meta strong { color: var(--text); font-size: 0.85rem; }
.msg-source { text-transform: uppercase; letter-spacing: 0.04em; }
.msg-body {
  white-space: pre-wrap;
  color: var(--text);
  font-size: 0.92rem;
  line-height: 1.45;
}

.composer {
  display: flex;
  gap: 0.5rem;
  align-items: flex-end;
  flex-shrink: 0;
  border-top: 1px solid var(--border);
  padding-top: 0.6rem;
}
.composer textarea {
  flex: 1;
  resize: none;
  padding: 0.55rem 0.7rem;
  border: 1px solid var(--border);
  border-radius: var(--radius-base);
  background: var(--bg-surface);
  color: var(--text);
  font: inherit;
  font-size: 0.92rem;
}
.composer textarea:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}
</style>

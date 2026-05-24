<script setup lang="ts">
import { onMounted } from "vue";
import { AppToast, GlobalConfirmDialog } from "@karyl-chan/ui";
import { useAppSession } from "./composables/use-app-session";
import DeniedView from "./views/DeniedView.vue";
import ManageView from "./views/ManageView.vue";
import ChatView from "./views/ChatView.vue";
import StickyView from "./views/StickyView.vue";
import ShowcaseView from "./views/ShowcaseView.vue";
import BenchView from "./views/BenchView.vue";

const { surface, deniedMessage, chatBinding, guildId, bootstrap } = useAppSession();

onMounted(bootstrap);
</script>

<template>
  <div class="root">
    <header class="header">
      <strong>Karyl Example</strong>
      <span class="surface-tag">{{ surface }}</span>
    </header>
    <main class="main">
      <div v-if="surface === 'loading'" class="loading">Loading…</div>
      <DeniedView v-else-if="surface === 'denied'" :message="deniedMessage" />
      <ManageView v-else-if="surface === 'manage'" :guild-id="guildId ?? ''" />
      <ChatView
        v-else-if="surface === 'chat' && chatBinding"
        :channel-id="chatBinding.channelId"
      />
      <StickyView v-else-if="surface === 'sticky'" />
      <ShowcaseView v-else-if="surface === 'showcase'" />
      <BenchView v-else-if="surface === 'bench'" />
    </main>
    <AppToast />
    <GlobalConfirmDialog />
  </div>
</template>

<style scoped>
.root {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}
.header {
  display: flex;
  align-items: baseline;
  gap: 0.6rem;
  padding: 0.6rem 1rem;
  border-bottom: 1px solid var(--border);
  background: var(--bg-surface);
  flex-shrink: 0;
}
.surface-tag {
  font-size: 0.75rem;
  font-weight: 500;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
.main {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}
.loading {
  padding: 2rem;
  color: var(--text-muted);
  text-align: center;
}
</style>

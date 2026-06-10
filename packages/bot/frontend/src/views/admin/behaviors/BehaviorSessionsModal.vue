<script setup lang="ts">
// BH-4.1 — active continuous-session 可見性：誰、哪條 behavior、哪個
// channel、何時開始/到期；admin 可強制結束。
import { ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { AppModal, AppButton } from '@karyl-chan/ui';
import {
    listBehaviorSessions,
    endBehaviorSession,
    type BehaviorSessionView,
} from '../../../api/behavior';

const { t } = useI18n();

const props = defineProps<{ visible: boolean }>();
const emit = defineEmits<{ (e: 'close'): void }>();

const sessions = ref<BehaviorSessionView[]>([]);
const loading = ref(false);
const error = ref<string | null>(null);

async function load() {
    loading.value = true;
    error.value = null;
    try {
        sessions.value = await listBehaviorSessions();
    } catch (err) {
        error.value = err instanceof Error ? err.message : String(err);
    } finally {
        loading.value = false;
    }
}

watch(() => props.visible, (v) => { if (v) void load(); });

async function onEnd(s: BehaviorSessionView) {
    try {
        await endBehaviorSession(s.userId, s.channelId);
        sessions.value = sessions.value.filter(
            (x) => !(x.userId === s.userId && x.channelId === s.channelId),
        );
    } catch (err) {
        error.value = err instanceof Error ? err.message : String(err);
    }
}

function fmt(iso: string | null): string {
    if (!iso) return '—';
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString();
}
</script>

<template>
    <AppModal :visible="visible" :title="t('behaviors.sessions.title')" @close="emit('close')">
        <p v-if="error" class="error" role="alert">{{ error }}</p>
        <p v-if="loading" class="muted">{{ t('common.loading') }}</p>
        <p v-else-if="sessions.length === 0" class="muted">
            {{ t('behaviors.sessions.empty') }}
        </p>
        <table v-else class="sessions-table">
            <thead>
                <tr>
                    <th>{{ t('behaviors.sessions.user') }}</th>
                    <th>{{ t('behaviors.sessions.behavior') }}</th>
                    <th>{{ t('behaviors.sessions.channel') }}</th>
                    <th>{{ t('behaviors.sessions.started') }}</th>
                    <th>{{ t('behaviors.sessions.expires') }}</th>
                    <th></th>
                </tr>
            </thead>
            <tbody>
                <tr v-for="s in sessions" :key="`${s.userId}:${s.channelId}`">
                    <td><code>{{ s.userId }}</code></td>
                    <td>{{ s.behaviorTitle }}</td>
                    <td><code>{{ s.channelId }}</code></td>
                    <td>{{ fmt(s.startedAt) }}</td>
                    <td>{{ fmt(s.expiresAt) }}</td>
                    <td>
                        <AppButton variant="danger" size="sm" @click="onEnd(s)">
                            {{ t('behaviors.sessions.end') }}
                        </AppButton>
                    </td>
                </tr>
            </tbody>
        </table>
    </AppModal>
</template>

<style scoped>
.sessions-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.88em;
}
.sessions-table th,
.sessions-table td {
    text-align: left;
    padding: 0.35rem 0.5rem;
    border-bottom: 1px solid var(--border, #333);
}
.error { color: var(--danger, #e66); }
.muted { opacity: 0.65; }
</style>

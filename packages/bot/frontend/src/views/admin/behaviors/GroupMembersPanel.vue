<script setup lang="ts">
// BH-1.2 — specific_group tab 的成員管理面板。
// 名單以 groupName 為鍵存在 bot 端（behavior_group_members），掛在這個
// tab 上的所有 behaviors 共享；增/刪即存（PUT 全量替換）。
import { ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Icon } from '@iconify/vue';
import { AppButton, AppTextField } from '@karyl-chan/ui';
import { getGroupMembers, setGroupMembers } from '../../../api/behavior';
import { useUserSummaries } from '../../../composables/use-user-summaries';

const { t } = useI18n();

const props = defineProps<{ groupName: string }>();

const members = ref<string[]>([]);
const newUserId = ref('');
const loading = ref(false);
const saving = ref(false);
const error = ref<string | null>(null);

// 餵 reactive 名單給 user-summary store,自動解析顯示名稱
const { getDisplayName } = useUserSummaries(members);

async function load() {
    loading.value = true;
    error.value = null;
    try {
        members.value = await getGroupMembers(props.groupName);
    } catch (err) {
        error.value = err instanceof Error ? err.message : String(err);
    } finally {
        loading.value = false;
    }
}

watch(() => props.groupName, () => void load(), { immediate: true });

async function save(next: string[]) {
    saving.value = true;
    error.value = null;
    try {
        members.value = await setGroupMembers(props.groupName, next);
    } catch (err) {
        error.value = err instanceof Error ? err.message : String(err);
    } finally {
        saving.value = false;
    }
}

async function addMember() {
    const id = newUserId.value.trim();
    if (!id) return;
    if (!/^\d{5,25}$/.test(id)) {
        error.value = t('behaviors.groupMembers.invalidId');
        return;
    }
    if (members.value.includes(id)) {
        newUserId.value = '';
        return;
    }
    await save([...members.value, id]);
    if (!error.value) newUserId.value = '';
}

async function removeMember(id: string) {
    await save(members.value.filter((m) => m !== id));
}
</script>

<template>
    <section class="group-members">
        <header class="gm-head">
            <Icon icon="material-symbols:groups-rounded" class="gm-icon" />
            <span class="gm-title">{{ t('behaviors.groupMembers.title') }}</span>
            <span class="gm-count">{{ t('behaviors.groupMembers.count', { count: members.length }) }}</span>
        </header>

        <p v-if="error" class="error" role="alert">{{ error }}</p>
        <p v-if="loading" class="muted">{{ t('common.loading') }}</p>

        <ul v-else-if="members.length > 0" class="gm-list">
            <li v-for="id in members" :key="id" class="gm-item">
                <span class="gm-name">{{ getDisplayName(id) ?? id }}</span>
                <code class="gm-id">{{ id }}</code>
                <button
                    class="gm-remove"
                    :disabled="saving"
                    :title="t('behaviors.groupMembers.remove')"
                    @click="removeMember(id)"
                >
                    <Icon icon="material-symbols:close-rounded" />
                </button>
            </li>
        </ul>
        <p v-else class="muted">{{ t('behaviors.groupMembers.empty') }}</p>

        <form class="gm-add" @submit.prevent="addMember">
            <AppTextField
                v-model="newUserId"
                :placeholder="t('behaviors.groupMembers.placeholder')"
                :maxlength="25"
            />
            <AppButton
                type="submit"
                variant="primary"
                size="sm"
                icon="material-symbols:person-add-rounded"
                :disabled="saving || !newUserId.trim()"
            >{{ t('behaviors.groupMembers.add') }}</AppButton>
        </form>
    </section>
</template>

<style scoped>
.group-members {
    border: 1px solid var(--border, #333);
    border-radius: 8px;
    padding: 0.75rem 1rem;
    margin-bottom: 1rem;
}
.gm-head {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 0.5rem;
}
.gm-icon { opacity: 0.7; }
.gm-title { font-weight: 600; }
.gm-count { opacity: 0.6; font-size: 0.85em; }
.gm-list {
    list-style: none;
    margin: 0 0 0.5rem;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
}
.gm-item {
    display: flex;
    align-items: center;
    gap: 0.5rem;
}
.gm-name { font-size: 0.9em; }
.gm-id { opacity: 0.6; font-size: 0.8em; }
.gm-remove {
    background: none;
    border: none;
    cursor: pointer;
    color: inherit;
    opacity: 0.6;
    display: inline-flex;
    padding: 0.15rem;
}
.gm-remove:hover { opacity: 1; }
.gm-add {
    display: flex;
    align-items: center;
    gap: 0.5rem;
}
.error { color: var(--danger, #e66); }
.muted { opacity: 0.65; }
</style>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Icon } from '@iconify/vue';
import { AppButton, AppTextField } from '@karyl-chan/ui';
import { getGroupMembers, replaceGroupMembers } from '../../../api/behavior';
import { useUserSummaries } from '../../../composables/use-user-summaries';
import { describeBehaviorError } from './behavior-errors';

/**
 * Members of an Audience Group. The list belongs to the group name and is
 * shared by every bot DM trigger using it; it can only be set while some
 * trigger uses the group (#137), so this panel is shown for the saved
 * group of a saved trigger. Adding or removing saves right away.
 */
const props = defineProps<{
    groupName: string;
    /** How many message triggers use this group. */
    usedBy: number;
}>();

const emit = defineEmits<{
    /** How many members the list has, after each load or save. */
    (e: 'members', count: number): void;
}>();

const { t } = useI18n();

const members = ref<string[]>([]);
const newUserId = ref('');
const loading = ref(false);
const saving = ref(false);
const error = ref<string | null>(null);

const { getDisplayName } = useUserSummaries(computed(() => members.value));

async function load() {
    loading.value = true;
    error.value = null;
    try {
        members.value = (await getGroupMembers(props.groupName)).members;
        emit('members', members.value.length);
    } catch (err) {
        error.value = describeBehaviorError(t, err);
    } finally {
        loading.value = false;
    }
}

watch(() => props.groupName, () => void load(), { immediate: true });

async function save(next: string[]): Promise<boolean> {
    saving.value = true;
    error.value = null;
    try {
        members.value = (await replaceGroupMembers(props.groupName, next)).members;
        emit('members', members.value.length);
        return true;
    } catch (err) {
        error.value = describeBehaviorError(t, err);
        return false;
    } finally {
        saving.value = false;
    }
}

async function add() {
    const id = newUserId.value.trim();
    if (!id) return;
    if (members.value.includes(id)) {
        newUserId.value = '';
        return;
    }
    if (await save([...members.value, id])) newUserId.value = '';
}
</script>

<template>
    <section class="group-members" :aria-label="t('behaviors.group.membersTitle', { group: groupName })">
        <header class="head">
            <Icon icon="material-symbols:groups-outline-rounded" width="16" height="16" aria-hidden="true" />
            <span class="title">{{ t('behaviors.group.membersTitle', { group: groupName }) }}</span>
            <span class="count">{{ t('behaviors.group.count', { count: members.length }) }}</span>
        </header>
        <p v-if="usedBy > 1" class="hint">{{ t('behaviors.group.shared', { count: usedBy }) }}</p>

        <p v-if="loading" class="hint">{{ t('common.loading') }}</p>
        <ul v-else-if="members.length > 0" class="chips">
            <li v-for="id in members" :key="id" class="chip">
                <span>{{ getDisplayName(id) ?? id }}</span>
                <button
                    type="button"
                    class="chip-remove"
                    :disabled="saving"
                    :aria-label="t('behaviors.group.remove', { user: getDisplayName(id) ?? id })"
                    @click="save(members.filter((m) => m !== id))"
                >
                    <Icon icon="material-symbols:close-rounded" width="14" height="14" />
                </button>
            </li>
        </ul>
        <p v-else class="hint">{{ t('behaviors.group.empty') }}</p>

        <!-- not a <form>: the panel sits inside the card's editor form -->
        <div class="add">
            <AppTextField
                v-model="newUserId"
                :placeholder="t('behaviors.group.addPlaceholder')"
                inputmode="numeric"
                :maxlength="20"
                @keydown.enter.prevent="add"
            />
            <AppButton type="button" size="sm" data-test="add-member" variant="secondary" icon="material-symbols:person-add-outline-rounded" :disabled="saving || !newUserId.trim()" @click="add">
                {{ t('behaviors.group.add') }}
            </AppButton>
        </div>
        <p v-if="error" class="error" role="alert">{{ error }}</p>
    </section>
</template>

<style scoped>
.group-members {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    padding: 0.55rem 0.7rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
}
.head {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    color: var(--text-muted);
}
.title { font-weight: 600; color: var(--text-strong); font-size: 0.85rem; }
.count { font-size: 0.78rem; }
.hint { margin: 0; font-size: 0.78rem; color: var(--text-muted); }
.chips {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem;
}
.chip {
    display: inline-flex;
    align-items: center;
    gap: 0.2rem;
    padding: 0.1rem 0.2rem 0.1rem 0.6rem;
    border-radius: 999px;
    background: var(--bg-page);
    border: 1px solid var(--border);
    font-size: 0.82rem;
}
.chip-remove {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    border: none;
    border-radius: 50%;
    background: none;
    color: var(--text-muted);
    cursor: pointer;
}
.chip-remove:hover:not(:disabled) { color: var(--text); background: var(--bg-surface-hover); }
.add {
    display: flex;
    align-items: flex-start;
    gap: 0.4rem;
}
.add :deep(.app-field) { flex: 1; }
.error { margin: 0; font-size: 0.78rem; color: var(--danger); }
</style>

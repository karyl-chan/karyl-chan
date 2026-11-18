<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { AppSelectField, AppTabs, AppTextField, UserItem, type SelectOption, type TabDef } from '@karyl-chan/ui';
import { useUserSummaryStore } from '../modules/discord-chat/stores/userSummaryStore';
import { useCurrentUserStore } from '../stores/currentUserStore';
import {
    useDmContacts,
    useGuildMemberSearch,
    useUserSources,
    type UserCandidate,
    type UserSource,
} from './use-user-sources';

/**
 * Picks one Discord user: `v-model` is the user id ('' = none). Three
 * ways to find the person, each shown only to an admin who may use it
 * (use-user-sources.ts):
 *
 *   - type the id, and see whose it is before using it
 *   - pick from the people who have DMed the bot
 *   - search a server's members by name
 *
 * With only the id source available there are no tabs: the picker is one
 * text field. `submit` fires on Enter in the id field, for callers that
 * add the user right away.
 */
const props = defineProps<{
    modelValue: string;
    /** The id field's label; none when the caller labels the picker itself. */
    label?: string;
    placeholder?: string;
    error?: string;
    disabled?: boolean;
    autofocus?: boolean;
}>();

const emit = defineEmits<{
    (e: 'update:modelValue', userId: string): void;
    (e: 'submit'): void;
}>();

const { t } = useI18n();
const summaries = useUserSummaryStore();
const { sources, searchableGuilds, deny, ensureGuilds } = useUserSources();
void ensureGuilds();
const currentUser = useCurrentUserStore();
// the signed-in admin may load after the picker mounts
watch(
    () => currentUser.user,
    () => void ensureGuilds()
);

const SNOWFLAKE = /^\d{17,20}$/;

const source = ref<UserSource>('id');
// a source that went away (a 403, the guild list emptied) leaves the id field
watch(sources, (available) => {
    if (!available.includes(source.value)) source.value = 'id';
});

const tabs = computed<TabDef[]>(() =>
    sources.value.map((key) => ({ key, label: t(`behaviors.userPicker.source.${key}`) }))
);

function pick(userId: string) {
    emit('update:modelValue', userId);
}

// ── by id: say whose id it is ───────────────────────────────────────────────

const typedId = computed(() => props.modelValue.trim());
watch(
    typedId,
    (id) => {
        // a name is a nicety: when the lookup fails the id stands as typed
        if (SNOWFLAKE.test(id)) summaries.resolve([id]).catch(() => undefined);
    },
    { immediate: true }
);
const preview = computed(() => (SNOWFLAKE.test(typedId.value) ? summaries.getSummary(typedId.value) : null));

// ── from the bot's DMs ──────────────────────────────────────────────────────

const dm = useDmContacts(() => deny('dm'));

// ── from a server's members ─────────────────────────────────────────────────

const guildId = ref('');
const guildOptions = computed<SelectOption<string>[]>(() =>
    searchableGuilds.value.map((g) => ({ value: g.id, label: g.name }))
);
const members = useGuildMemberSearch(guildId, () => deny('guild'));

watch(source, (next) => {
    if (next === 'dm') void dm.load();
    if (next === 'guild' && !guildId.value && searchableGuilds.value.length === 1) {
        guildId.value = searchableGuilds.value[0].id;
    }
});

const candidates = computed<UserCandidate[]>(() => (source.value === 'dm' ? dm.shown.value : members.results.value));
const listLoading = computed(() => (source.value === 'dm' ? dm.loading.value : members.loading.value));
</script>

<template>
    <div class="user-picker">
        <AppTabs
            v-if="tabs.length > 1"
            :model-value="source"
            :tabs="tabs"
            variant="underline"
            data-test="user-sources"
            @update:model-value="source = $event as UserSource"
        />

        <template v-if="source === 'id'">
            <AppTextField
                :model-value="modelValue"
                :label="label"
                :placeholder="placeholder ?? t('behaviors.userPicker.idPlaceholder')"
                :error="error"
                :disabled="disabled"
                :autofocus="autofocus"
                inputmode="numeric"
                :maxlength="20"
                data-test="user-id"
                @update:model-value="pick(String($event))"
                @keydown.enter.prevent="emit('submit')"
            />
            <UserItem
                v-if="preview"
                class="preview"
                data-test="user-preview"
                :user-id="preview.id"
                :avatar-url="preview.avatarUrl"
                :name="preview.globalName ?? preview.username"
                :subtitle="preview.globalName ? preview.username : null"
                :is-bot="preview.bot"
                :avatar-size="28"
            />
        </template>

        <template v-else>
            <AppTextField
                v-if="source === 'dm'"
                v-model="dm.filter.value"
                :placeholder="t('behaviors.userPicker.filterPlaceholder')"
                :disabled="disabled"
                data-test="user-filter"
            />
            <div v-else class="guild-search">
                <AppSelectField
                    v-model="guildId"
                    :options="guildOptions"
                    :placeholder="t('behaviors.location.guildPlaceholder')"
                    :drawer-title="t('behaviors.location.guildPicker')"
                    :disabled="disabled"
                    filter
                />
                <AppTextField
                    v-model="members.query.value"
                    :placeholder="t('behaviors.userPicker.memberPlaceholder')"
                    :disabled="disabled || !guildId"
                    data-test="member-query"
                />
            </div>

            <ul v-if="candidates.length > 0" class="candidates" data-test="user-candidates">
                <li v-for="c in candidates" :key="c.id">
                    <UserItem
                        interactive
                        :user-id="c.id"
                        :avatar-url="c.avatarUrl"
                        :name="c.name"
                        :subtitle="c.subtitle"
                        :is-bot="c.bot"
                        :avatar-size="28"
                        :active="c.id === typedId"
                        :disabled="disabled"
                        @click="pick(c.id)"
                    />
                </li>
            </ul>
            <p v-else class="empty" data-test="user-empty">
                {{ listLoading ? t('common.loading') : t('behaviors.userPicker.empty') }}
            </p>
            <p v-if="error" class="error" role="alert">{{ error }}</p>
        </template>
    </div>
</template>

<style scoped>
.user-picker {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    min-width: 0;
}
.guild-search {
    display: flex;
    gap: 0.4rem;
}
.guild-search > * { flex: 1; min-width: 0; }
.candidates {
    list-style: none;
    margin: 0;
    padding: 0;
    max-height: 14rem;
    overflow-y: auto;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
}
.candidates :deep(.user-item) { width: 100%; }
.preview { padding: 0 0.1rem; }
.empty { margin: 0; font-size: 0.78rem; color: var(--text-muted); }
.error { margin: 0; font-size: 0.75rem; color: var(--danger); }
</style>

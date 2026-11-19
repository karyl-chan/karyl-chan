<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { Icon } from '@iconify/vue';
import { AppBadge, AppButton, AppSelectField, Cluster, Spacer, Stack, type SelectOption } from '@karyl-chan/ui';
import {
    getBehaviorDmAllowlist,
    getBehaviorDmLog,
    type BehaviorDmAllowlist,
    type BehaviorDmLogEntry,
    type BehaviorDmOutcome,
} from '../../../api/behavior';
import UserPicker from '../../../components/UserPicker.vue';
import { useRelativeTime } from '../../../composables/use-relative-time';
import { useUserSummaries } from '../../../composables/use-user-summaries';
import { describeBehaviorError } from './behavior-errors';
import GroupMembersPanel from './GroupMembersPanel.vue';
import { useTargetDirectory } from './target-directory';
import type { DmAllowlistDraft } from './use-dm-allowlist-draft';

/**
 * A behavior's direct messages to other users (#157): its DM allowlist —
 * users and Audience Groups — and its DM log (the last 50, 30 days).
 * Loaded when the section is opened, not before. A user is found with
 * UserPicker; a group is picked from the group targets (ADR 0004). A group
 * on the list shows its members here, read-only: they are edited on the
 * group's own page.
 *
 * Adding or removing only edits `allowlist`, the draft the surrounding
 * form owns: the form's save writes it, its cancel drops it.
 */
const props = defineProps<{ allowlist: DmAllowlistDraft }>();

const { t } = useI18n();
const { relativeTime } = useRelativeTime();
const directory = useTargetDirectory();

const SNOWFLAKE = /^[0-9]{17,20}$/;

// unsaved edits are shown again when the form is reopened
const open = ref(props.allowlist.dirty);
const loading = ref(false);
const loadError = ref<string | null>(null);
const inputError = ref<string | null>(null);
const list = computed(() => props.allowlist.list);
const saving = computed(() => props.allowlist.saving);
const error = computed(() => inputError.value ?? props.allowlist.error ?? loadError.value);
const entries = ref<BehaviorDmLogEntry[] | null>(null);
const newUserId = ref('');
const newGroup = ref('');

/** The group targets not on the list yet. */
const groupOptions = computed<SelectOption<string>[]>(() => {
    const listed = new Set(list.value?.groupNames ?? []);
    return directory.targets.value
        .flatMap((target) => (target.kind === 'group' && target.groupName ? [target.groupName] : []))
        .filter((name) => !listed.has(name))
        .map((name) => ({ value: name, label: name }));
});

/** A listed group's target key, when the page lists that group. */
function groupTarget(name: string) {
    return directory.targets.value.find((target) => target.kind === 'group' && target.groupName === name) ?? null;
}

const hasList = computed(() => !!list.value && (list.value.userIds.length > 0 || list.value.groupNames.length > 0));
const shownUsers = computed(() => [
    ...(list.value?.userIds ?? []),
    ...(entries.value ?? []).flatMap((e) => [e.recipientUserId, e.triggererUserId]),
]);
const { getDisplayName } = useUserSummaries(shownUsers);
const nameOf = (id: string) => getDisplayName(id) ?? id;

const OUTCOME_TONE: Record<BehaviorDmOutcome, 'success' | 'danger' | 'warn'> = {
    sent: 'success',
    not_allowed: 'danger',
    rate_limited: 'warn',
    attachment_failed: 'danger',
    failed: 'danger',
};

async function load(): Promise<void> {
    loading.value = true;
    loadError.value = null;
    try {
        const id = props.allowlist.behaviorId;
        const [allowlist, log] = await Promise.all([getBehaviorDmAllowlist(id), getBehaviorDmLog(id)]);
        props.allowlist.loaded(allowlist);
        entries.value = log.entries;
    } catch (err) {
        loadError.value = describeBehaviorError(t, err);
    } finally {
        loading.value = false;
    }
}

async function toggle(): Promise<void> {
    open.value = !open.value;
    if (open.value) await load();
}

const current = (): BehaviorDmAllowlist => list.value ?? { userIds: [], groupNames: [] };

function edit(next: BehaviorDmAllowlist): void {
    inputError.value = null;
    props.allowlist.edit(next);
}

function addUser(): void {
    const id = newUserId.value.trim();
    if (!SNOWFLAKE.test(id)) {
        inputError.value = t('behaviors.directMessages.badUserId');
        return;
    }
    const now = current();
    if (!now.userIds.includes(id)) edit({ ...now, userIds: [...now.userIds, id] });
    newUserId.value = '';
}

function addGroup(): void {
    const name = newGroup.value.trim();
    if (!name) return;
    const now = current();
    if (!now.groupNames.includes(name)) edit({ ...now, groupNames: [...now.groupNames, name] });
    newGroup.value = '';
}

function removeUser(id: string): void {
    const now = current();
    edit({ ...now, userIds: now.userIds.filter((u) => u !== id) });
}

function removeGroup(name: string): void {
    const now = current();
    edit({ ...now, groupNames: now.groupNames.filter((g) => g !== name) });
}

function absolute(iso: string): string {
    return new Date(iso).toLocaleString();
}
</script>

<template>
    <section class="direct-messages">
        <Stack gap="2">
            <Cluster gap="2">
                <button
                    type="button"
                    class="toggle"
                    data-test="dm-toggle"
                    :aria-expanded="open ? 'true' : 'false'"
                    @click="toggle"
                >
                    <Icon :icon="open ? 'material-symbols:expand-less-rounded' : 'material-symbols:expand-more-rounded'" width="16" height="16" aria-hidden="true" />
                    {{ t('behaviors.directMessages.title') }}
                </button>
                <Spacer />
                <AppButton v-if="open" size="sm" variant="ghost" :loading="loading" data-test="dm-refresh" @click="load">
                    {{ t('behaviors.directMessages.refresh') }}
                </AppButton>
            </Cluster>

            <template v-if="open">
                <p v-if="loading && !list" class="muted">{{ t('behaviors.directMessages.loading') }}</p>
                <template v-if="list">
                    <h4 class="sub">{{ t('behaviors.directMessages.allowlistTitle') }}</h4>
                    <p class="muted note" data-test="dm-rule">
                        {{ hasList ? t('behaviors.directMessages.ruleList') : t('behaviors.directMessages.ruleNone') }}
                    </p>

                    <ul v-if="list.userIds.length || list.groupNames.length" class="chips" data-test="dm-chips">
                        <li v-for="id in list.userIds" :key="`u${id}`" class="chip" data-test="dm-user">
                            <Icon icon="material-symbols:person-outline-rounded" width="14" height="14" aria-hidden="true" />
                            <span>{{ nameOf(id) }}</span>
                            <button
                                type="button"
                                class="chip-remove"
                                :disabled="saving"
                                :aria-label="t('behaviors.directMessages.remove', { name: nameOf(id) })"
                                @click="removeUser(id)"
                            >
                                <Icon icon="material-symbols:close-rounded" width="14" height="14" />
                            </button>
                        </li>
                        <li v-for="g in list.groupNames" :key="`g${g}`" class="chip" data-test="dm-group">
                            <Icon icon="material-symbols:groups-outline-rounded" width="14" height="14" aria-hidden="true" />
                            <span>{{ g }}</span>
                            <button
                                type="button"
                                class="chip-remove"
                                :disabled="saving"
                                :aria-label="t('behaviors.directMessages.remove', { name: g })"
                                @click="removeGroup(g)"
                            >
                                <Icon icon="material-symbols:close-rounded" width="14" height="14" />
                            </button>
                        </li>
                    </ul>

                    <!-- not a <form>: the section sits inside the card's editor form -->
                    <div class="add">
                        <UserPicker
                            v-model="newUserId"
                            class="picker"
                            data-test="dm-user-input"
                            :placeholder="t('behaviors.directMessages.userPlaceholder')"
                            :disabled="saving"
                            @submit="addUser"
                        />
                        <AppButton type="button" size="sm" variant="secondary" data-test="dm-add-user" :disabled="saving || !newUserId.trim()" @click="addUser">
                            {{ t('behaviors.directMessages.addUser') }}
                        </AppButton>
                    </div>
                    <div class="add">
                        <div class="picker" data-test="dm-group-input">
                            <AppSelectField
                                v-model="newGroup"
                                :options="groupOptions"
                                :placeholder="t('behaviors.directMessages.groupPlaceholder')"
                                :drawer-title="t('behaviors.directMessages.addGroup')"
                                :disabled="groupOptions.length === 0"
                                filter
                            />
                        </div>
                        <AppButton type="button" size="sm" variant="secondary" data-test="dm-add-group" :disabled="saving || !newGroup.trim()" @click="addGroup">
                            {{ t('behaviors.directMessages.addGroup') }}
                        </AppButton>
                    </div>
                    <p v-if="allowlist.dirty" class="muted note" role="status" data-test="dm-unsaved">
                        {{ t('behaviors.directMessages.unsaved') }}
                    </p>

                    <div v-for="g in list.groupNames" :key="`m${g}`" class="listed-group">
                        <GroupMembersPanel :group-name="g" readonly />
                        <button
                            v-if="directory.open && groupTarget(g)"
                            type="button"
                            class="link"
                            data-test="dm-edit-group"
                            @click="directory.open(groupTarget(g)!.key)"
                        >
                            {{ t('behaviors.directMessages.editGroup') }}
                        </button>
                    </div>
                </template>
                <template v-if="entries">
                    <h4 class="sub">{{ t('behaviors.directMessages.logTitle') }}</h4>
                    <p v-if="entries.length === 0" class="muted" data-test="dm-log-empty">{{ t('behaviors.directMessages.logEmpty') }}</p>
                    <ol v-else class="rows">
                        <li v-for="e in entries" :key="e.id" class="row" data-test="dm-log-row">
                            <Cluster gap="2">
                                <time :datetime="e.at" :title="absolute(e.at)" class="muted">{{ relativeTime(e.at) }}</time>
                                <AppBadge size="sm" :tone="OUTCOME_TONE[e.outcome]" data-test="dm-outcome">
                                    {{ t(`behaviors.directMessages.outcome.${e.outcome}`) }}
                                </AppBadge>
                                <span>{{ t('behaviors.directMessages.logLine', { to: nameOf(e.recipientUserId), by: nameOf(e.triggererUserId) }) }}</span>
                            </Cluster>
                        </li>
                    </ol>
                    <p class="muted note">{{ t('behaviors.directMessages.retention') }}</p>
                </template>
            </template>
            <p v-if="error" class="error" role="alert">{{ error }}</p>
        </Stack>
    </section>
</template>

<style scoped>
.direct-messages {
    font-size: 0.85rem;
}
.toggle {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    padding: 0;
    border: none;
    background: none;
    color: var(--text-strong);
    font: inherit;
    font-weight: 600;
    cursor: pointer;
}
.sub {
    margin: 0.2rem 0 0;
    font-size: 0.82rem;
    color: var(--text-strong);
}
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
    gap: 0.25rem;
    padding: 0.1rem 0.2rem 0.1rem 0.5rem;
    border-radius: 999px;
    background: var(--bg-page);
    border: 1px solid var(--border);
    font-size: 0.82rem;
    max-width: 100%;
    overflow-wrap: anywhere;
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
.add .picker { flex: 1; min-width: 0; }
.listed-group {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 0.25rem;
}
.listed-group > :first-child { align-self: stretch; }
.link {
    padding: 0;
    border: none;
    background: none;
    color: var(--accent-text-strong);
    font: inherit;
    font-size: 0.78rem;
    cursor: pointer;
}
.link:hover { text-decoration: underline; }
.rows {
    list-style: none;
    margin: 0;
    padding: 0;
    max-height: 18rem;
    overflow: auto;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
}
.row {
    padding: 0.4rem 0.6rem;
    border-bottom: 1px solid var(--border);
    overflow-wrap: anywhere;
}
.row:last-child { border-bottom: none; }
.muted { margin: 0; color: var(--text-muted); }
.note { font-size: 0.78rem; }
.error { margin: 0; color: var(--danger); }
</style>

<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Icon } from '@iconify/vue';
import {
    AppBadge,
    AppButton,
    AppItemCard,
    AppMenu,
    AppMenuItem,
    AppTextField,
    AppToggle,
    Stack,
    useConfirm,
    useToastStore,
} from '@karyl-chan/ui';
import { deleteBehavior, updateBehavior, type MessageTriggerView } from '../../../api/behavior';
import GroupMembersPanel from './GroupMembersPanel.vue';
import MessageTriggerFields from './MessageTriggerFields.vue';
import MessageTriggerReadOnly from './MessageTriggerReadOnly.vue';
import WebhookActionFields from './WebhookActionFields.vue';
import WebhookTestResult from './WebhookTestResult.vue';
import { NO_ERRORS, describeBehaviorError, errorsFromRefusal, isStale, type FormErrors } from './behavior-errors';
import { keepEditsOn, rebaseDraft } from './draft-rebase';
import {
    checkMessageTriggerDraft,
    fieldsWithErrorLine,
    hasErrors,
    type TriggerFormLayout,
} from './message-trigger-check';
import { draftPatcher, draftFromTrigger, draftLocation, isDirty, toPatchBody } from './message-trigger-draft';
import { locationKey } from './message-trigger-location';
import { sectionLabel } from './section-labels';
import { draftLeavesGroup, useSoleGroup } from './use-sole-group';
import { trackUnsavedDraft } from './use-unsaved-drafts';

/**
 * A Message Trigger (board 7): the header row toggles, test-fires and
 * deletes; the expanded body edits the trigger (MessageTriggerFields) and
 * its action (WebhookActionFields). The System Behavior's trigger stays
 * read-only and pinned (S7 #139 adds its trigger switch).
 *
 * The saved trigger (`base`) and the edit draft are kept apart (#105): a
 * new version from the server — the answer to the enabled toggle, a reload
 * — never overwrites edits in progress (see rebaseDraft).
 */
const props = defineProps<{
    trigger: MessageTriggerView;
    /** Open the card (and bring it into view) — e.g. right after it was created. */
    expand?: boolean;
    guildNames: ReadonlyMap<string, string>;
    /** Audience Groups in use, sorted, and how many triggers use each. */
    groupNames: readonly string[];
    groupUse: ReadonlyMap<string, number>;
}>();

const emit = defineEmits<{
    (e: 'updated', trigger: MessageTriggerView): void;
    (e: 'deleted', id: number): void;
    /** The list is out of date (a stale write was refused). */
    (e: 'reload'): void;
}>();

const { t } = useI18n();
const { confirm } = useConfirm();
const toast = useToastStore();

/** The card edits everything: any location, nothing fixed. */
const LAYOUT: TriggerFormLayout = {
    kinds: ['bot_dm', 'guild_all', 'guild', 'channel'],
    lockGuild: false,
    lockChannel: false,
    description: true,
};

const isSystem = computed(() => props.trigger.systemKey !== null);
const open = ref(props.expand ?? false);
const root = ref<HTMLElement | null>(null);
function bringIntoView() {
    requestAnimationFrame(() => root.value?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' }));
}
watch(
    () => props.expand,
    (expand) => {
        if (!expand) return;
        open.value = true;
        bringIntoView();
    }
);
onMounted(() => {
    if (props.expand) bringIntoView();
});

// ── saved state vs. edit draft ──────────────────────────────────────────────

const base = ref(props.trigger);
const draft = ref(draftFromTrigger(props.trigger));
const applyPatch = draftPatcher(draft);
const conflict = ref(false);
/** The last save was refused as stale; the list was reloaded under the draft. */
const stale = ref(false);
const dirty = computed(() => isDirty(base.value, draft.value));
trackUnsavedDraft(`behavior:${props.trigger.id}`, dirty);

watch(
    () => props.trigger,
    (incoming) => {
        if (incoming === base.value) return;
        const next = rebaseDraft(base.value, draft.value, incoming);
        base.value = next.base;
        draft.value = next.draft;
        conflict.value = next.conflict;
    }
);

/** Keep my edits, applied onto the latest version (the next save is based on it). */
function keepMine() {
    stale.value = false;
    draft.value = keepEditsOn(base.value, draft.value, props.trigger);
    base.value = props.trigger;
    conflict.value = false;
}

function discard() {
    stale.value = false;
    base.value = props.trigger;
    draft.value = draftFromTrigger(props.trigger);
    conflict.value = false;
    errors.value = NO_ERRORS;
}

// ── save ────────────────────────────────────────────────────────────────────

const errors = ref<FormErrors>(NO_ERRORS);
const saving = ref(false);
const issuedSecret = ref<string | null>(null);

/** Saving is blocked while a conflict is open: it would only be refused again. */
const canSave = computed(() => dirty.value && !saving.value && !conflict.value);

async function save() {
    const patch = toPatchBody(base.value, draft.value);
    if (!patch || !canSave.value) return;
    saving.value = true;
    stale.value = false;
    try {
        const found = await checkMessageTriggerDraft(t, draft.value, LAYOUT);
        errors.value = found;
        if (hasErrors(found)) return;
        const result = await updateBehavior(props.trigger.id, patch);
        const saved = result.behavior as MessageTriggerView;
        issuedSecret.value = result.secret ?? null;
        base.value = saved;
        draft.value = draftFromTrigger(saved);
        emit('updated', saved);
    } catch (err) {
        if (isStale(err)) {
            // the reload decides: a changed form field keeps the conflict
            // open; otherwise the edits are rebased and only need saving again
            conflict.value = true;
            stale.value = true;
            errors.value = NO_ERRORS;
            emit('reload');
        } else {
            errors.value = errorsFromRefusal(t, err, fieldsWithErrorLine(draft.value, LAYOUT));
        }
    } finally {
        saving.value = false;
    }
}

// ── header actions ──────────────────────────────────────────────────────────

const toggling = ref(false);
async function setEnabled(enabled: boolean) {
    toggling.value = true;
    try {
        // not tied to a version: switching on / off is meant to win
        const result = await updateBehavior(props.trigger.id, { enabled });
        emit('updated', result.behavior as MessageTriggerView);
    } catch (err) {
        toast.show(describeBehaviorError(t, err));
    } finally {
        toggling.value = false;
    }
}

const tester = ref<InstanceType<typeof WebhookTestResult> | null>(null);
async function testFire() {
    open.value = true;
    await nextTick();
    await tester.value?.run();
}

// ── the sole user of a group: its member list goes with it ─────────────────

const soleGroup = useSoleGroup(base, () => props.groupUse, open);

const groupDropWarning = computed(() => {
    const group = soleGroup.group.value;
    const count = soleGroup.members.value ?? 0;
    return group && count > 0 && draftLeavesGroup(group, draft.value)
        ? t('behaviors.group.dropOnSave', { group, count })
        : '';
});

async function remove() {
    const group = soleGroup.group.value;
    const count = await soleGroup.load();
    const ok = await confirm({
        title: t('behaviors.card.deleteTitle'),
        message: [
            t('behaviors.card.deleteMessage', { title: props.trigger.title }),
            group && count > 0 ? t('behaviors.group.dropOnDelete', { group, count }) : '',
        ]
            .filter(Boolean)
            .join(' '),
        confirmLabel: t('behaviors.card.delete'),
        confirmVariant: 'danger',
        cancelLabel: t('common.cancel'),
    });
    if (!ok) return;
    try {
        await deleteBehavior(props.trigger.id);
        emit('deleted', props.trigger.id);
    } catch (err) {
        toast.show(describeBehaviorError(t, err));
    }
}

// ── view ────────────────────────────────────────────────────────────────────

const unhealthy = computed(() => (props.trigger.stats?.consecutiveFailures ?? 0) >= 3);
const patternSummary = computed(() =>
    t(`behaviors.card.pattern.${props.trigger.patternKind}`, { value: props.trigger.patternValue })
);

/** Where saving would move the trigger, once the location is complete. */
const moved = computed(() => {
    const target = draftLocation(draft.value);
    if (!target || locationKey(target) === props.trigger.section) return null;
    return {
        section: sectionLabel(t, locationKey(target), props.guildNames),
        // leaving bot DMs: replies land in a channel, in front of everyone
        public: props.trigger.surface === 'bot_dm' && target.kind !== 'bot_dm',
    };
});

/** The members panel is for the saved group (only a group in use takes members). */
const savedGroup = computed(() =>
    base.value.audienceKind === 'group' &&
    draft.value.audienceKind === 'group' &&
    draft.value.audienceGroupName.trim() === base.value.audienceGroupName
        ? base.value.audienceGroupName
        : null
);
</script>

<template>
    <div ref="root">
        <AppItemCard
            :expanded="open"
            :disabled="!trigger.enabled"
            :accent-bar="isSystem ? 'neutral' : 'accent'"
            @update:expanded="open = $event"
        >
            <template #leading>
                <span v-if="isSystem" class="lead" :title="t('behaviors.card.systemRowLocked')">
                    <Icon icon="material-symbols:lock-outline" width="16" height="16" aria-hidden="true" />
                </span>
                <slot v-else name="handle">
                    <span class="lead" aria-hidden="true">
                        <Icon icon="material-symbols:chat-outline-rounded" width="16" height="16" />
                    </span>
                </slot>
            </template>

            <template #title>
                <span class="title">{{ trigger.title }}</span>
                <span class="summary">{{ patternSummary }}</span>
            </template>

            <template #trailing>
                <AppBadge v-if="dirty" size="sm" tone="warn" icon="material-symbols:edit-outline-rounded">
                    {{ t('behaviors.card.unsaved') }}
                </AppBadge>
                <AppBadge size="sm" icon="material-symbols:article-outline">
                    {{ t('behaviors.card.triggerMessage') }}
                </AppBadge>
                <AppBadge v-if="isSystem" size="sm" icon="material-symbols:settings-outline" :title="t('behaviors.card.tagSystem')">
                    {{ t('behaviors.card.tagSystemShort') }}
                </AppBadge>
                <AppBadge v-if="trigger.stopOnMatch" size="sm" tone="warn" icon="material-symbols:stop-circle-outline-rounded" :title="t('behaviors.card.tagStop')">
                    {{ t('behaviors.card.tagStopShort') }}
                </AppBadge>
                <AppBadge v-if="unhealthy" size="sm" tone="danger" icon="material-symbols:heart-broken-rounded" :title="trigger.stats?.lastError ?? ''">
                    {{ t('behaviors.card.unhealthy') }}
                </AppBadge>
                <AppToggle
                    :model-value="trigger.enabled"
                    :disabled="isSystem || toggling"
                    data-test="enabled-toggle"
                    :title="isSystem ? t('behaviors.card.toggleProtected') : undefined"
                    :aria-label="trigger.enabled ? t('behaviors.card.enabled') : t('behaviors.card.disabled')"
                    @update:model-value="setEnabled"
                />
                <AppMenu v-if="!isSystem" placement="bottom-end" :offset="[0, 6]">
                    <template #trigger>
                        <button type="button" class="more-btn" :aria-label="t('behaviors.card.more')" :title="t('behaviors.card.more')">
                            <Icon icon="material-symbols:more-vert" width="16" height="16" />
                        </button>
                    </template>
                    <AppMenuItem data-test="test-fire" @click="testFire">
                        <Icon icon="material-symbols:send-outline-rounded" width="16" height="16" />
                        {{ t('behaviors.card.test') }}
                    </AppMenuItem>
                    <AppMenuItem danger data-test="delete" @click="remove">
                        <Icon icon="material-symbols:delete-outline-rounded" width="16" height="16" />
                        {{ t('behaviors.card.delete') }}
                    </AppMenuItem>
                </AppMenu>
            </template>

            <Stack v-if="isSystem" gap="2">
                <MessageTriggerReadOnly :trigger="trigger" :guild-names="guildNames" />
            </Stack>

            <form v-else class="editor" @submit.prevent="save">
                <Stack gap="3">
                    <WebhookTestResult ref="tester" :behavior-id="trigger.id" />

                    <div class="grid">
                        <AppTextField v-model="draft.title" :label="t('behaviors.card.titleLabel')" :error="errors.fields.title" />
                        <AppTextField
                            v-model="draft.description"
                            :label="t('behaviors.card.descriptionLabel')"
                            :hint="t('behaviors.card.descriptionHint')"
                            :error="errors.fields.description"
                        />
                    </div>

                    <MessageTriggerFields
                        :draft="draft"
                        :kinds="LAYOUT.kinds"
                        :errors="errors.fields"
                        :group-names="groupNames"
                        :moved="moved"
                        @patch="applyPatch"
                    >
                        <template #group-members>
                            <GroupMembersPanel
                                v-if="savedGroup"
                                :group-name="savedGroup"
                                :used-by="groupUse.get(savedGroup) ?? 1"
                                @members="soleGroup.members.value = $event"
                            />
                            <p v-else class="hint">{{ t('behaviors.group.saveFirst') }}</p>
                        </template>
                    </MessageTriggerFields>

                    <WebhookActionFields
                        :draft="draft"
                        :errors="errors.fields"
                        :saved="base.webhook"
                        :behavior-id="trigger.id"
                        :issued-secret="issuedSecret"
                        @patch="applyPatch"
                        @rotated="emit('reload')"
                    />

                    <p v-if="groupDropWarning" class="warning" role="status" data-test="group-drop">{{ groupDropWarning }}</p>

                    <div v-if="conflict" class="conflict" role="alert" data-test="conflict">
                        <span>{{ t('behaviors.card.conflict') }}</span>
                        <AppButton size="sm" variant="secondary" data-test="keep-mine" @click="keepMine">
                            {{ t('behaviors.card.conflictKeep') }}
                        </AppButton>
                        <AppButton size="sm" variant="ghost" @click="discard">
                            {{ t('behaviors.card.conflictDiscard') }}
                        </AppButton>
                    </div>
                    <p v-else-if="stale" class="hint" role="status" data-test="stale">
                        {{ t('behaviors.card.staleRebased') }}
                    </p>
                    <p v-if="errors.general" class="error" role="alert" data-test="general-error">{{ errors.general }}</p>

                    <footer class="footer">
                        <AppButton variant="secondary" :disabled="!dirty || saving" @click="discard">
                            {{ t('common.cancel') }}
                        </AppButton>
                        <AppButton type="submit" data-test="save" :loading="saving" :disabled="!canSave">
                            {{ t('common.save') }}
                        </AppButton>
                    </footer>
                </Stack>
            </form>
        </AppItemCard>
    </div>
</template>

<style scoped>
.lead {
    color: var(--text-muted);
    display: inline-flex;
    align-items: center;
    padding: 0.25rem;
}
.title {
    font-weight: 600;
    color: var(--text-strong);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex-shrink: 0;
    max-width: 50%;
}
.summary {
    color: var(--text-muted);
    font-size: 0.8rem;
    font-family: var(--font-mono, ui-monospace, monospace);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
}
.more-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    background: none;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-muted);
    cursor: pointer;
    padding: 0;
}
.more-btn:hover { background: var(--bg-surface-hover, var(--bg-page)); color: var(--text); }
.grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr));
    gap: 0.6rem 1rem;
}
.hint { margin: 0; font-size: 0.78rem; color: var(--text-muted); }
.warning { margin: 0; font-size: 0.82rem; color: var(--warn-text, var(--text)); }
.conflict {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 0.7rem;
    border: 1px solid var(--warn-text, var(--border));
    border-radius: var(--radius-sm);
    font-size: 0.85rem;
}
.conflict span { flex: 1; min-width: 12rem; }
.error { margin: 0; font-size: 0.82rem; color: var(--danger); }
.footer {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
    padding-top: 0.75rem;
    border-top: 1px solid var(--border);
}
</style>

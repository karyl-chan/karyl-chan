<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { AppBadge, AppItemCard, AppMenu, AppMenuItem, AppSelectField, AppTextArea, AppTextField, AppToggle, useConfirm, type AccentBarTone } from '@karyl-chan/ui';
import { Icon } from '@iconify/vue';
import BehaviorSourceNotice from './BehaviorSourceNotice.vue';
import {
    type BehaviorRow,
    type BehaviorTriggerType,
    type BehaviorForwardType,
    type BehaviorScope,
    type BehaviorWebhookAuthMode,
    type BehaviorPatchPayload,
    type BehaviorCommandOption,
    type ScopeTabRow,
    updateBehavior,
    deleteBehavior,
} from '../../../api/behavior';

/**
 * BehaviorCard v2
 *
 * Two sources:
 * - custom：完全可編輯（trigger / 三軸 / audience / webhook URL+secret+mode）
 * - system：只可編輯 trigger value + enabled
 * webhookAuthMode UI（CR-2）：source=custom + webhookSecret 有值時顯示 mode select
 */

const { t } = useI18n();
const { confirm } = useConfirm();

const props = defineProps<{
    behavior: BehaviorRow;
    scopeTab?: ScopeTabRow | null;
    initiallyOpen?: boolean;
}>();

const emit = defineEmits<{
    (e: 'updated', row: BehaviorRow): void;
    (e: 'deleted', id: number): void;
    (e: 'toggle', open: boolean): void;
}>();

const open = ref(!!props.initiallyOpen);

// ── source 計算屬性 ───────────────────────────────────────────────────────────

const isCustom = computed(() => props.behavior.source === 'custom');
const isSystem = computed(() => props.behavior.source === 'system');
// admin-login / break 是逃生口（取得後台連結、結束 session），停用後找不回，
// 由後端 403 + 前端 toggle disabled 雙層保護。manual 可關。
const isProtectedSystem = computed(
    () => isSystem.value && (props.behavior.systemKey === 'admin-login' || props.behavior.systemKey === 'break'),
);

// ── draft（可編輯欄位）────────────────────────────────────────────────────────

interface Draft {
    // 共同
    title: string;
    description: string;
    enabled: boolean;
    forwardType: BehaviorForwardType;
    stopOnMatch: boolean;
    ignoreBots: boolean;
    // trigger（custom 全可改；system 只能改 value）
    triggerType: BehaviorTriggerType;
    messagePatternKind: string;
    messagePatternValue: string;
    slashCommandName: string;
    slashCommandDescription: string;
    slashCommandOptions: BehaviorCommandOption[];
    // 三軸（custom 可改；system 唯讀）
    scope: BehaviorScope;
    integrationTypes: string;
    contexts: string;
    // audience（custom 可改）
    audienceKind: string;
    audienceUserId: string;
    audienceGroupName: string;
    // webhook（custom 全可改）
    webhookUrl: string;
    webhookSecret: string;
    webhookAuthMode: BehaviorWebhookAuthMode | '';
}

// BH-2.2C：slash options 定義（DB 存 JSON 字串 → 編輯用陣列）
function parseOptionsJson(raw: string | null): BehaviorCommandOption[] {
    if (!raw) return [];
    try {
        const parsed = JSON.parse(raw) as BehaviorCommandOption[];
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

const OPTION_TYPE_CHOICES = [
    'string', 'integer', 'number', 'boolean', 'user', 'channel', 'role', 'mentionable', 'attachment',
] as const;

function draftFrom(row: BehaviorRow): Draft {
    return {
        title: row.title,
        description: row.description,
        enabled: row.enabled,
        forwardType: row.forwardType,
        stopOnMatch: row.stopOnMatch,
        ignoreBots: row.ignoreBots,
        triggerType: row.triggerType,
        messagePatternKind: row.messagePatternKind ?? 'startswith',
        messagePatternValue: row.messagePatternValue ?? '',
        slashCommandName: row.slashCommandName ?? '',
        slashCommandDescription: row.slashCommandDescription ?? '',
        slashCommandOptions: parseOptionsJson(row.slashCommandOptions),
        scope: row.scope,
        integrationTypes: row.integrationTypes,
        contexts: row.contexts,
        audienceKind: row.audienceKind,
        audienceUserId: row.audienceUserId ?? '',
        audienceGroupName: row.audienceGroupName ?? '',
        webhookUrl: row.webhookUrl ?? '',
        webhookSecret: row.webhookSecret ?? '',
        webhookAuthMode: row.webhookAuthMode ?? '',
    };
}

const draft = reactive<Draft>(draftFrom(props.behavior));

const optionTypeOptions = OPTION_TYPE_CHOICES.map((v) => ({ value: v, label: v }));
function addOption() {
    draft.slashCommandOptions.push({ type: 'string', name: '', description: '', required: false });
}
function removeOption(index: number) {
    draft.slashCommandOptions.splice(index, 1);
}
const saving = ref(false);
const error = ref<string | null>(null);

const enabledLocal = ref(props.behavior.enabled);

watch(() => props.behavior, (next) => {
    Object.assign(draft, draftFrom(next));
});
watch(() => props.behavior.enabled, (next) => {
    enabledLocal.value = next;
});

// ── select options ────────────────────────────────────────────────────────────

const triggerTypeOptions = computed(() => [
    { value: 'slash_command' as BehaviorTriggerType, label: t('behaviors.card.triggerSlashCommand') },
    { value: 'message_pattern' as BehaviorTriggerType, label: t('behaviors.card.triggerPattern') },
]);

const messagePatternKindOptions = [
    { value: 'startswith', label: t('behaviors.card.triggerStartsWith') },
    { value: 'endswith', label: t('behaviors.card.triggerEndsWith') },
    { value: 'regex', label: t('behaviors.card.triggerRegex') },
];

const forwardTypeOptions = computed(() => [
    { value: 'one_time' as BehaviorForwardType, label: t('behaviors.card.forwardOneTime') },
    { value: 'continuous' as BehaviorForwardType, label: t('behaviors.card.forwardContinuous') },
]);

const scopeOptions = [
    { value: 'global' as BehaviorScope, label: 'global' },
    { value: 'guild' as BehaviorScope, label: 'guild' },
];

// Integration types — Discord 端的「可安裝範圍」。只有 global_all
// scope tab 給 admin 自選；其他 tab 由 deriveFieldsFromTab() 寫死。
// UI 在非 global_all 時改顯示 readonly 提示,並阻止送出。
const canEditIntegrationTypes = computed(
    () => props.scopeTab?.tabType === 'global_all',
);
// integrationTypes 是 slash 指令的安裝面設定;message_pattern 不經指令
// 註冊,顯示這個欄位會誤導 admin 以為有效(BH-0.2),整塊隱藏。
const showIntegrationTypes = computed(
    () => draft.triggerType === 'slash_command',
);
// 3 種有意義的組合（單獨 guild / 單獨 user / 兩者皆可），computed 把
// 存進 DB 的 comma-joined 字串（sortJoin 排序過）映射回 enum。
type IntegrationMode = 'both' | 'guild_only' | 'user_only';
const integrationModeOptions = computed<{ value: IntegrationMode; label: string }[]>(() => [
    { value: 'both', label: t('behaviors.card.integrationBoth') },
    { value: 'guild_only', label: t('behaviors.card.integrationGuildOnly') },
    { value: 'user_only', label: t('behaviors.card.integrationUserOnly') },
]);
const integrationMode = computed<IntegrationMode>({
    get() {
        const parts = new Set(
            draft.integrationTypes.split(',').map((s) => s.trim()).filter(Boolean),
        );
        if (parts.has('guild_install') && parts.has('user_install')) return 'both';
        if (parts.has('user_install')) return 'user_only';
        return 'guild_only';
    },
    set(mode) {
        draft.integrationTypes =
            mode === 'both'
                ? 'guild_install,user_install'
                : mode === 'user_only'
                  ? 'user_install'
                  : 'guild_install';
    },
});

const webhookAuthModeOptions = computed(() => [
    { value: 'token' as BehaviorWebhookAuthMode, label: 'Token' },
    { value: 'hmac' as BehaviorWebhookAuthMode, label: 'HMAC' },
]);

// webhookAuthMode 顯示條件（CR-2）：source=custom + webhookSecret 有值
const showAuthModeSelect = computed(() =>
    isCustom.value && draft.webhookSecret.length > 0
);

// ── trigger summary（卡片頭部）───────────────────────────────────────────────

const triggerSummary = computed(() => {
    const b = props.behavior;
    if (b.triggerType === 'slash_command') {
        return t('behaviors.card.previewSlashCommand', { value: b.slashCommandName ?? '' });
    }
    const v = b.messagePatternValue ?? '';
    const truncated = v.length > 40 ? `${v.slice(0, 37)}…` : v;
    if (b.messagePatternKind === 'startswith') return t('behaviors.card.previewStartsWith', { value: truncated });
    if (b.messagePatternKind === 'endswith') return t('behaviors.card.previewEndsWith', { value: truncated });
    return t('behaviors.card.previewRegex', { value: truncated });
});

// ── dirty 計算 ────────────────────────────────────────────────────────────────

const dirty = computed(() => {
    const b = props.behavior;
    if (isSystem.value) {
        // system 可改 triggerType + 對應子欄位（其餘 title / 三軸 / forward
        // / webhook 唯讀，不參與 dirty 判定）。
        if (draft.triggerType !== b.triggerType) return true;
        if (draft.triggerType === 'slash_command') {
            return (
                draft.slashCommandName !== (b.slashCommandName ?? '') ||
                draft.slashCommandDescription !== (b.slashCommandDescription ?? '')
            );
        }
        return (
            draft.messagePatternKind !== (b.messagePatternKind ?? 'startswith') ||
            draft.messagePatternValue !== (b.messagePatternValue ?? '')
        );
    }
    // custom
    return (
        draft.title !== b.title ||
        draft.description !== b.description ||
        draft.triggerType !== b.triggerType ||
        draft.messagePatternKind !== (b.messagePatternKind ?? 'startswith') ||
        draft.messagePatternValue !== (b.messagePatternValue ?? '') ||
        draft.slashCommandName !== (b.slashCommandName ?? '') ||
        draft.slashCommandDescription !== (b.slashCommandDescription ?? '') ||
        JSON.stringify(draft.slashCommandOptions) !== JSON.stringify(parseOptionsJson(b.slashCommandOptions)) ||
        draft.scope !== b.scope ||
        draft.integrationTypes !== b.integrationTypes ||
        draft.contexts !== b.contexts ||
        draft.audienceKind !== b.audienceKind ||
        draft.audienceUserId !== (b.audienceUserId ?? '') ||
        draft.audienceGroupName !== (b.audienceGroupName ?? '') ||
        draft.webhookUrl !== (b.webhookUrl ?? '') ||
        draft.webhookSecret !== (b.webhookSecret ?? '') ||
        draft.webhookAuthMode !== (b.webhookAuthMode ?? '') ||
        draft.forwardType !== b.forwardType ||
        draft.stopOnMatch !== b.stopOnMatch ||
        draft.ignoreBots !== b.ignoreBots
    );
});

// ── toggle enabled ────────────────────────────────────────────────────────────

// AppItemCard owns the expanded state via v-model; this is the bridge
// between its `update:expanded` and the parent BehaviorWorkspace, which
// uses the `toggle` event to scroll-anchor on expand.
function onExpandChange(next: boolean): void {
    open.value = next;
    emit('toggle', next);
}

// Map behaviour `source` (custom / system) to the AppItemCard
// accent-stripe palette.
const accentBarTone = computed<AccentBarTone | null>(() =>
    props.behavior.source === 'custom' ? 'accent' : 'neutral'
);

async function onToggleEnabled() {
    // protected system keys（admin-login / break）由後端 403 攔，
    // 前端也擋一道避免無謂 round-trip + UI 閃動。
    if (saving.value || isProtectedSystem.value) return;
    const next = !enabledLocal.value;
    enabledLocal.value = next;
    saving.value = true;
    error.value = null;
    try {
        const updated = await updateBehavior(props.behavior.id, { enabled: next });
        emit('updated', updated);
    } catch (err) {
        error.value = err instanceof Error ? err.message : String(err);
        enabledLocal.value = props.behavior.enabled;
    } finally {
        saving.value = false;
    }
}

// ── save ──────────────────────────────────────────────────────────────────────

async function onSave() {
    if (saving.value) return;
    error.value = null;
    saving.value = true;

    try {
        let patch: BehaviorPatchPayload = {};

        if (isSystem.value) {
            // system：更新 triggerType + 對應子欄位（後端會在切換時 null
            // 掉另一側欄位以滿足 model invariant）。
            patch.triggerType = draft.triggerType;
            if (draft.triggerType === 'slash_command') {
                if (!draft.slashCommandName.trim()) {
                    error.value = t('behaviors.card.triggerValueRequired');
                    return;
                }
                patch.slashCommandName = draft.slashCommandName.trim();
                patch.slashCommandDescription = draft.slashCommandDescription;
            } else {
                if (!draft.messagePatternValue.trim()) {
                    error.value = t('behaviors.card.triggerValueRequired');
                    return;
                }
                if (draft.messagePatternKind === 'regex') {
                    try { new RegExp(draft.messagePatternValue); } catch {
                        error.value = t('behaviors.card.regexInvalid');
                        return;
                    }
                }
                patch.messagePatternKind = draft.messagePatternKind as BehaviorRow['messagePatternKind'];
                patch.messagePatternValue = draft.messagePatternValue.trim();
            }
        } else {
            // custom：全欄位
            if (!draft.title.trim()) {
                error.value = t('behaviors.card.titleRequired');
                return;
            }
            patch = {
                title: draft.title.trim(),
                description: draft.description,
                triggerType: draft.triggerType,
                scope: draft.scope,
                contexts: draft.contexts,
                audienceKind: draft.audienceKind as BehaviorRow['audienceKind'],
                audienceUserId: draft.audienceKind === 'user' ? (draft.audienceUserId.trim() || null) : null,
                audienceGroupName: draft.audienceKind === 'group' ? (draft.audienceGroupName.trim() || null) : null,
                forwardType: draft.forwardType,
            };
            // stopOnMatch / ignoreBots 是 pattern 專屬語意(BH-0.3/BH-3) — slash 不送。
            if (draft.triggerType === 'message_pattern') {
                patch.stopOnMatch = draft.stopOnMatch;
                patch.ignoreBots = draft.ignoreBots;
            }
            // 只在 global_all tab + slash trigger 才送 integrationTypes —
            // 其他 tab 由後端 deriveFieldsFromTab() 寫死、message_pattern
            // 沒有安裝面,送過去後端都會 400 拒絕。
            if (canEditIntegrationTypes.value && draft.triggerType === 'slash_command') {
                patch.integrationTypes = draft.integrationTypes;
            }
            if (draft.triggerType === 'slash_command') {
                if (!draft.slashCommandName.trim()) {
                    error.value = t('behaviors.card.triggerValueRequired');
                    return;
                }
                patch.slashCommandName = draft.slashCommandName.trim();
                patch.slashCommandDescription = draft.slashCommandDescription;
                // BH-2.2C：options 定義（空陣列 → null 清除）
                for (const opt of draft.slashCommandOptions) {
                    if (!/^[a-z0-9_-]{1,32}$/.test(opt.name) || !opt.description.trim()) {
                        error.value = t('behaviors.card.optionInvalid', { name: opt.name || '?' });
                        return;
                    }
                }
                patch.slashCommandOptions =
                    draft.slashCommandOptions.length > 0 ? draft.slashCommandOptions : null;
                patch.messagePatternKind = null;
                patch.messagePatternValue = null;
            } else {
                if (!draft.messagePatternValue.trim()) {
                    error.value = t('behaviors.card.triggerValueRequired');
                    return;
                }
                if (draft.messagePatternKind === 'regex') {
                    try { new RegExp(draft.messagePatternValue); } catch {
                        error.value = t('behaviors.card.regexInvalid');
                        return;
                    }
                }
                patch.messagePatternKind = draft.messagePatternKind as BehaviorRow['messagePatternKind'];
                patch.messagePatternValue = draft.messagePatternValue.trim();
                patch.slashCommandName = null;
                patch.slashCommandDescription = null;
            }
            // webhookUrl / secret（custom 路徑用 webhookUrl 直接設定）
            if (draft.webhookUrl !== (props.behavior.webhookUrl ?? '')) {
                patch.webhookUrl = draft.webhookUrl.trim() || null;
            }
            if (draft.webhookSecret !== (props.behavior.webhookSecret ?? '')) {
                patch.webhookSecret = draft.webhookSecret.length === 0 ? null : draft.webhookSecret;
                if (draft.webhookSecret.length > 0) {
                    patch.webhookAuthMode = (draft.webhookAuthMode as BehaviorWebhookAuthMode) || 'token';
                }
            } else if (draft.webhookAuthMode !== (props.behavior.webhookAuthMode ?? '')) {
                patch.webhookAuthMode = (draft.webhookAuthMode as BehaviorWebhookAuthMode) || null;
            }
        }

        const updated = await updateBehavior(props.behavior.id, patch);
        emit('updated', updated);
    } catch (err) {
        error.value = err instanceof Error ? err.message : String(err);
    } finally {
        saving.value = false;
    }
}

// ── delete ────────────────────────────────────────────────────────────────────

async function onDelete() {
    if (!await confirm({ title: 'Delete', message: t('behaviors.card.deleteConfirm', { title: props.behavior.title }), confirmLabel: 'Delete', confirmVariant: 'danger' })) return;
    saving.value = true;
    try {
        await deleteBehavior(props.behavior.id);
        emit('deleted', props.behavior.id);
    } catch (err) {
        error.value = err instanceof Error ? err.message : String(err);
        saving.value = false;
    }
}

// ── save 按鈕文字（依 source 變化）──────────────────────────────────────────

const saveLabel = computed(() => {
    if (isSystem.value) return t('behaviors.card.saveTrigger');
    return t('common.save');
});
</script>

<template>
    <AppItemCard
        :class="['behavior-card', `behavior-card--${behavior.source}`]"
        :expanded="open"
        :disabled="!enabledLocal"
        :accent-bar="accentBarTone"
        @update:expanded="onExpandChange"
    >
        <!-- drag-handle：custom 可拖曳，其他 locked -->
        <template #leading>
            <button
                v-if="isCustom"
                type="button"
                class="drag-handle"
                :title="t('behaviors.card.dragHint')"
                :aria-label="t('behaviors.card.dragHint')"
            >
                <Icon icon="material-symbols:drag-indicator" width="18" height="18" />
            </button>
            <span
                v-else
                class="drag-handle drag-handle--locked"
                :title="t('behaviors.card.systemRowLocked')"
                aria-hidden="true"
            >
                <Icon icon="material-symbols:lock-outline" width="16" height="16" />
            </span>
        </template>

        <template #title>
            <span class="title">{{ behavior.title }}</span>
            <span class="trigger-summary">{{ triggerSummary }}</span>
        </template>

        <template #trailing>
            <!-- trigger-badge pill -->
            <AppBadge
                size="sm"
                :tone="behavior.triggerType === 'slash_command' ? 'accent' : 'neutral'"
                :variant="behavior.triggerType === 'slash_command' ? 'outline' : 'soft'"
                :icon="behavior.triggerType === 'slash_command' ? 'material-symbols:bolt-outline-rounded' : 'material-symbols:article-outline'"
                :title="behavior.triggerType === 'slash_command' ? 'Slash 指令' : 'Message Pattern'"
            >
                {{ behavior.triggerType === 'slash_command' ? 'slash' : 'pattern' }}
            </AppBadge>

            <!-- source-badge（custom 不顯示，system 顯示鎖） -->
            <AppBadge
                v-if="isSystem"
                size="sm"
                tone="neutral"
                icon="material-symbols:settings-outline"
                :title="t('behaviors.card.tagSystem')"
            >
                {{ t('behaviors.card.tagSystemShort') }}
            </AppBadge>

            <!-- 連續對話 tag -->
            <AppBadge
                v-if="behavior.forwardType === 'continuous'"
                size="sm"
                tone="accent"
                icon="material-symbols:loop-rounded"
                :title="t('behaviors.card.tagContinuous')"
            >
                {{ t('behaviors.card.tagContinuousShort') }}
            </AppBadge>

            <!-- stop-on-match tag — pattern 專屬語意(BH-0.3)：命中後擋住
                 後續比對。slash 指令名唯一、天然單一匹配,不顯示。 -->
            <AppBadge
                v-if="behavior.stopOnMatch && behavior.triggerType === 'message_pattern'"
                size="sm"
                tone="warn"
                icon="material-symbols:stop-circle-outline-rounded"
                :title="t('behaviors.card.tagStop')"
            >
                {{ t('behaviors.card.tagStopShort') }}
            </AppBadge>

            <!-- toggle — system 也顯示，但 admin-login / break 鎖死（系統保護）。 -->
            <AppToggle
                :model-value="enabledLocal"
                :title="
                    isProtectedSystem
                        ? t('behaviors.card.toggleProtected')
                        : enabledLocal
                            ? t('behaviors.card.toggleEnabled')
                            : t('behaviors.card.toggleDisabled')
                "
                :aria-label="enabledLocal ? t('behaviors.card.toggleEnabled') : t('behaviors.card.toggleDisabled')"
                :disabled="saving || isProtectedSystem"
                @update:model-value="onToggleEnabled"
            />

            <!-- 三點 menu（只 custom 有刪除） -->
            <AppMenu v-if="isCustom" placement="bottom-end" :offset="[0, 6]">
                <template #trigger>
                    <button
                        type="button"
                        class="menu-trigger"
                        :title="t('behaviors.card.moreActions')"
                        :aria-label="t('behaviors.card.moreActions')"
                    >
                        <Icon icon="material-symbols:more-vert" width="18" height="18" />
                    </button>
                </template>
                <AppMenuItem :disabled="saving" danger @click="onDelete">
                    <Icon icon="material-symbols:delete-outline-rounded" width="16" height="16" />
                    {{ t('common.delete') }}
                </AppMenuItem>
            </AppMenu>
        </template>

        <!-- ─ card body ─────────────────────────────────────────────────── -->
        <template #default>

                <!-- source notice banner（system） -->
                <BehaviorSourceNotice v-if="isSystem" :source="behavior.source" />

                <!-- ═══ source=custom：完全可編輯 ════════════════════════════ -->
                <template v-if="isCustom">
                    <div class="grid">
                        <AppTextField
                            v-model="draft.title"
                            :label="t('behaviors.card.title')"
                            :maxlength="200"
                            fullWidth
                        />
                        <AppTextArea
                            v-model="draft.description"
                            :label="t('behaviors.card.description')"
                            :rows="2"
                            :maxlength="2000"
                            fullWidth
                        />

                        <!-- trigger section -->
                        <div class="field">
                            <span class="label">{{ t('behaviors.card.triggerType') }}</span>
                            <AppSelectField v-model="draft.triggerType" :options="triggerTypeOptions" />
                        </div>

                        <template v-if="draft.triggerType === 'slash_command'">
                            <AppTextField
                                v-model="draft.slashCommandName"
                                :label="t('behaviors.card.slashCommandName')"
                                :maxlength="100"
                                placeholder="指令名稱"
                            />
                            <AppTextField
                                v-model="draft.slashCommandDescription"
                                :label="t('behaviors.card.slashCommandDescription')"
                                :maxlength="200"
                                fullWidth
                            />

                            <!-- BH-2.2C：slash options 定義 -->
                            <div class="field full options-editor">
                                <span class="label">{{ t('behaviors.card.options') }}</span>
                                <div v-for="(opt, i) in draft.slashCommandOptions" :key="i" class="option-row">
                                    <AppTextField
                                        v-model="opt.name"
                                        :placeholder="t('behaviors.card.optionName')"
                                        :maxlength="32"
                                    />
                                    <AppTextField
                                        v-model="opt.description"
                                        :placeholder="t('behaviors.card.optionDescription')"
                                        :maxlength="100"
                                    />
                                    <AppSelectField v-model="opt.type" :options="optionTypeOptions" />
                                    <label class="inline">
                                        <input type="checkbox" v-model="opt.required" />
                                        <span>{{ t('behaviors.card.optionRequired') }}</span>
                                    </label>
                                    <button type="button" class="option-remove" @click="removeOption(i)">
                                        <Icon icon="material-symbols:close-rounded" />
                                    </button>
                                </div>
                                <button type="button" class="option-add" @click="addOption">
                                    <Icon icon="material-symbols:add-rounded" />
                                    {{ t('behaviors.card.optionAdd') }}
                                </button>
                            </div>
                        </template>

                        <template v-else>
                            <div class="field">
                                <span class="label">{{ t('behaviors.card.messagePatternKind') }}</span>
                                <AppSelectField v-model="draft.messagePatternKind" :options="messagePatternKindOptions" />
                            </div>
                            <AppTextField
                                v-model="draft.messagePatternValue"
                                :label="t('behaviors.card.messagePatternValue')"
                                :maxlength="2000"
                            />
                        </template>

                        <!-- 可安裝範圍 — 僅 slash command 有安裝面;
                             message_pattern 整塊隱藏(BH-0.2)。global_all
                             tab 可自選,其他 tab 由 deriveFieldsFromTab()
                             寫死,顯示 readonly 提示讓 admin 知道為何不能改。 -->
                        <div v-if="showIntegrationTypes && canEditIntegrationTypes" class="field">
                            <span class="label">{{ t('behaviors.card.integrationTypes') }}</span>
                            <AppSelectField v-model="integrationMode" :options="integrationModeOptions" />
                        </div>
                        <AppTextField
                            v-else-if="showIntegrationTypes"
                            :modelValue="integrationModeOptions.find((o) => o.value === integrationMode)?.label ?? ''"
                            :label="t('behaviors.card.integrationTypes')"
                            :hint="t('behaviors.card.integrationTypesLocked')"
                            readonly
                            muted
                        />

                        <!-- 轉發設定 -->
                        <div class="field">
                            <span class="label">{{ t('behaviors.card.forwardType') }}</span>
                            <AppSelectField v-model="draft.forwardType" :options="forwardTypeOptions" />
                        </div>

                        <!-- webhook 設定 -->
                        <AppTextField
                            v-model="draft.webhookUrl"
                            :label="t('behaviors.card.webhookUrl')"
                            placeholder="https://…"
                            :maxlength="1000"
                            fullWidth
                        />
                        <AppTextField
                            v-model="draft.webhookSecret"
                            :label="t('behaviors.card.webhookSecret')"
                            :hint="t('behaviors.card.webhookSecretHint')"
                            :placeholder="t('behaviors.card.webhookSecretPlaceholder')"
                            :maxlength="200"
                            autocomplete="off"
                            fullWidth
                        />

                        <!-- webhookAuthMode（CR-2）：有 secret 時才顯示 -->
                        <div v-if="showAuthModeSelect" class="field">
                            <span class="label">{{ t('behaviors.card.webhookAuthMode') }}</span>
                            <AppSelectField v-model="draft.webhookAuthMode" :options="webhookAuthModeOptions" />
                        </div>

                        <!-- stopOnMatch 是 message_pattern 專屬(BH-0.3)：
                             一則訊息依 sortOrder 比對所有 pattern,勾選後
                             命中即擋住後續比對(continuous/system 命中必停,
                             不受此欄位影響)。slash 指令名唯一,無此語意。 -->
                        <label
                            v-if="draft.triggerType === 'message_pattern'"
                            class="field full inline"
                        >
                            <input type="checkbox" v-model="draft.stopOnMatch" />
                            <span>{{ t('behaviors.card.stopOnMatch') }}</span>
                            <span class="hint">{{ t('behaviors.card.stopOnMatchHint') }}</span>
                        </label>

                        <!-- ignoreBots 僅對 guild 頻道 pattern 有意義(BH-3)：
                             DM 裡 bot 互傳不存在。本 bot 自身訊息無論如何
                             都會被忽略。 -->
                        <label
                            v-if="draft.triggerType === 'message_pattern' && draft.contexts.includes('Guild')"
                            class="field full inline"
                        >
                            <input type="checkbox" v-model="draft.ignoreBots" />
                            <span>{{ t('behaviors.card.ignoreBots') }}</span>
                            <span class="hint">{{ t('behaviors.card.ignoreBotsHint') }}</span>
                        </label>
                    </div>
                </template>

                <!-- ═══ source=system：可改 triggerType + 對應子欄位 ═══════════ -->
                <template v-else-if="isSystem">
                    <!-- 唯讀區 -->
                    <div class="grid readonly-grid">
                        <AppTextField
                            :modelValue="behavior.title"
                            :label="t('behaviors.card.title')"
                            readonly
                            muted
                            fullWidth
                        />
                    </div>

                    <!-- 可編輯：trigger -->
                    <div class="section-divider">{{ t('behaviors.card.triggerSection') }}</div>
                    <div class="grid">
                        <div class="field">
                            <span class="label">{{ t('behaviors.card.triggerType') }}</span>
                            <AppSelectField v-model="draft.triggerType" :options="triggerTypeOptions" />
                        </div>

                        <template v-if="draft.triggerType === 'slash_command'">
                            <AppTextField
                                v-model="draft.slashCommandName"
                                :label="t('behaviors.card.slashCommandName')"
                                :maxlength="100"
                            />
                            <AppTextField
                                v-model="draft.slashCommandDescription"
                                :label="t('behaviors.card.slashCommandDescription')"
                                :maxlength="200"
                                fullWidth
                            />

                            <!-- BH-2.2C：slash options 定義 -->
                            <div class="field full options-editor">
                                <span class="label">{{ t('behaviors.card.options') }}</span>
                                <div v-for="(opt, i) in draft.slashCommandOptions" :key="i" class="option-row">
                                    <AppTextField
                                        v-model="opt.name"
                                        :placeholder="t('behaviors.card.optionName')"
                                        :maxlength="32"
                                    />
                                    <AppTextField
                                        v-model="opt.description"
                                        :placeholder="t('behaviors.card.optionDescription')"
                                        :maxlength="100"
                                    />
                                    <AppSelectField v-model="opt.type" :options="optionTypeOptions" />
                                    <label class="inline">
                                        <input type="checkbox" v-model="opt.required" />
                                        <span>{{ t('behaviors.card.optionRequired') }}</span>
                                    </label>
                                    <button type="button" class="option-remove" @click="removeOption(i)">
                                        <Icon icon="material-symbols:close-rounded" />
                                    </button>
                                </div>
                                <button type="button" class="option-add" @click="addOption">
                                    <Icon icon="material-symbols:add-rounded" />
                                    {{ t('behaviors.card.optionAdd') }}
                                </button>
                            </div>
                        </template>
                        <template v-else>
                            <div class="field">
                                <span class="label">{{ t('behaviors.card.messagePatternKind') }}</span>
                                <AppSelectField v-model="draft.messagePatternKind" :options="messagePatternKindOptions" />
                            </div>
                            <AppTextField
                                v-model="draft.messagePatternValue"
                                :label="t('behaviors.card.messagePatternValue')"
                                :maxlength="2000"
                                fullWidth
                            />
                        </template>
                    </div>
                </template>

                <!-- error 訊息 -->
                <p v-if="error" class="error" role="alert">{{ error }}</p>

                <!-- actions footer -->
                <footer class="actions">
                    <span class="spacer" />
                    <button
                        type="button"
                        class="primary"
                        :disabled="!dirty || saving"
                        @click="onSave"
                    >
                        {{ saving ? t('common.saving') : saveLabel }}
                    </button>
                </footer>
        </template>
    </AppItemCard>
</template>

<style scoped>
/* ── drag-handle (left of AppItemCard's expand button) ─────────── */
.drag-handle {
    background: none;
    border: none;
    color: var(--text-muted);
    cursor: grab;
    padding: 0.25rem;
    display: inline-flex;
    align-items: center;
    flex-shrink: 0;
}
.drag-handle:active { cursor: grabbing; }
.drag-handle--locked {
    cursor: default;
    color: var(--text-faint, var(--text-muted));
    display: inline-flex;
    align-items: center;
    padding: 0.25rem;
    flex-shrink: 0;
}

/* ── title row (inside AppItemCard's #title slot) ──────────────── */
.title {
    font-weight: 600;
    color: var(--text-strong);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex-shrink: 0;
    max-width: 50%;
}
.trigger-summary {
    color: var(--text-muted);
    font-size: 0.8rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
}

/* ── kebab menu trigger button ─────────────────────────────────── */
.menu-trigger {
    flex-shrink: 0;
    background: none;
    border: 1px solid transparent;
    color: var(--text-muted);
    width: 28px;
    height: 28px;
    border-radius: var(--radius-sm);
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
}
.menu-trigger:hover { background: var(--bg-surface-hover); color: var(--text); }

/* ── grid ────────────────────────────────────────────────────── */
.grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.6rem;
}
.field { display: flex; flex-direction: column; gap: 0.25rem; min-width: 0; }
.field.full { grid-column: 1 / -1; }
.field.inline { flex-direction: row; align-items: center; gap: 0.5rem; cursor: pointer; padding: 0.2rem 0; }
.field.inline input[type="checkbox"] {
    width: auto;
    min-width: 0;
    flex-shrink: 0;
    padding: 0;
    margin: 0;
    accent-color: var(--accent);
}
.field.inline span { color: var(--text); font-size: 0.9rem; }
.label {
    font-size: 0.75rem;
    color: var(--text-muted);
    font-weight: 600;
    display: flex;
    gap: 0.35rem;
    align-items: center;
}
.hint {
    font-size: 0.7rem;
    font-weight: 400;
    color: var(--text-faint, var(--text-muted));
}
/* ── 唯讀區 ──────────────────────────────────────────────────── */
.readonly-grid {
    background: var(--bg-page);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 0.6rem;
}

/* ── section divider ─────────────────────────────────────────── */
.section-divider {
    font-size: 0.72rem;
    font-weight: 700;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    padding: 0.15rem 0;
    border-bottom: 1px solid var(--border);
}

/* field-group-title */
.field-group-title {
    grid-column: 1 / -1;
    font-size: 0.72rem;
    font-weight: 700;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    padding-top: 0.25rem;
    border-bottom: 1px solid var(--border);
    padding-bottom: 0.15rem;
}

/* ── actions ─────────────────────────────────────────────────── */
.error { color: var(--danger); margin: 0; font-size: 0.85rem; }
.actions {
    display: flex;
    align-items: center;
    gap: 0.5rem;
}
.spacer { flex: 1; }
.actions button {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    padding: 0.45rem 0.85rem;
    border-radius: var(--radius-sm);
    cursor: pointer;
    font: inherit;
    border: 1px solid var(--border);
    background: var(--bg-surface);
    color: var(--text);
}
.actions .primary {
    background: var(--accent);
    color: var(--text-on-accent);
    border-color: var(--accent);
}
.actions .primary:disabled { opacity: 0.55; cursor: not-allowed; }

@media (max-width: 640px) {
    .grid { grid-template-columns: 1fr; }
}

/* BH-2.2C options editor */
.options-editor .option-row {
    display: grid;
    grid-template-columns: 1fr 2fr auto auto auto;
    gap: 0.5rem;
    align-items: center;
    margin-bottom: 0.4rem;
}
.options-editor .option-remove,
.options-editor .option-add {
    background: none;
    border: 1px solid var(--border, #444);
    border-radius: 6px;
    color: inherit;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    padding: 0.3rem 0.5rem;
    opacity: 0.8;
}
.options-editor .option-remove:hover,
.options-editor .option-add:hover { opacity: 1; }
.options-editor label.inline {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    white-space: nowrap;
}
</style>

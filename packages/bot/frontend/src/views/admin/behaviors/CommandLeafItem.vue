<script setup lang="ts">
import { computed, nextTick, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { Icon } from '@iconify/vue';
import { AppBadge, AppButton, AppMenu, AppMenuItem, AppToggle, Stack } from '@karyl-chan/ui';
import {
    updateBehavior,
    type CommandLeafView,
    type CommandView,
    type RegistrationReport,
} from '../../../api/behavior';
import CommandLeafFields from './CommandLeafFields.vue';
import WebhookTestResult from './WebhookTestResult.vue';
import { NO_ERRORS, errorsFromRefusal, hasErrors, isStale, type FormErrors } from './behavior-errors';
import { checkLeafDraft, leafFieldsWithErrorLine, type LeafFormKind } from './leaf-check';
import { commandPath } from './command-draft';
import { leafDraftModel } from './leaf-draft';
import { isRegistrationRefusal } from './registration-result';
import { useDraftForm } from './use-draft-form';

/**
 * One Command Leaf of a command card (board 5): the root leaf (the command
 * itself, always open) or a subcommand row that opens to edit it. Each
 * leaf saves on its own — PATCH /api/behaviors/:id with ifUpdatedAt — and
 * a change Discord sees re-registers the command; the card shows what
 * Discord answered (`wrote` / `refused`).
 */
const props = defineProps<{
    command: CommandView;
    leaf: CommandLeafView;
    /** A secret the bot generated when this leaf was just added — shown once. */
    addedSecret?: string | null;
}>();

const emit = defineEmits<{
    (e: 'wrote', result: { command: CommandView; registration?: RegistrationReport }): void;
    /** A write Discord refused (registration_failed): nothing changed. */
    (e: 'refused', err: unknown): void;
    (e: 'reload'): void;
    /** Delete this leaf (the list decides how: the last one takes the command). */
    (e: 'remove', leaf: CommandLeafView): void;
}>();

const { t } = useI18n();

const kind = computed<LeafFormKind>(() => (props.leaf.subcommand === '' ? 'root' : 'subcommand'));
const isRoot = computed(() => kind.value === 'root');
const open = ref(isRoot.value || !!props.addedSecret);
const path = computed(() => commandPath(props.command.name, props.leaf.subcommand));

// ── saved leaf vs. edit draft ───────────────────────────────────────────────

const form = useDraftForm(leafDraftModel, () => props.leaf, `behavior:${props.leaf.id}`);
const { base, draft, conflict, stale, dirty, applyPatch, keepMine } = form;

function discard() {
    form.discard();
    errors.value = NO_ERRORS;
}

// ── writes ──────────────────────────────────────────────────────────────────

const errors = ref<FormErrors>(NO_ERRORS);
const saving = ref(false);
const issuedSecret = ref<string | null>(props.addedSecret ?? null);
const canSave = computed(() => dirty.value && !saving.value && !conflict.value);

async function save() {
    const patch = form.pendingPatch();
    if (!patch || !canSave.value) return;
    saving.value = true;
    stale.value = false;
    try {
        const found = await checkLeafDraft(t, draft.value, kind.value);
        errors.value = found;
        if (hasErrors(found)) return;
        const result = await updateBehavior(props.leaf.id, patch);
        const saved = result.behavior as CommandLeafView;
        issuedSecret.value = result.secret ?? null;
        form.adopt(saved);
        if (result.command) emit('wrote', { command: result.command, registration: result.registration });
    } catch (err) {
        if (isStale(err)) {
            form.refusedAsStale();
            errors.value = NO_ERRORS;
            emit('reload');
        } else if (isRegistrationRefusal(err)) {
            errors.value = NO_ERRORS;
            emit('refused', err);
        } else {
            errors.value = errorsFromRefusal(t, err, leafFieldsWithErrorLine(draft.value, kind.value));
        }
    } finally {
        saving.value = false;
    }
}

const toggling = ref(false);
async function setEnabled(enabled: boolean) {
    toggling.value = true;
    try {
        // not tied to a version: switching on / off is meant to win
        const result = await updateBehavior(props.leaf.id, { enabled });
        if (result.command) emit('wrote', { command: result.command, registration: result.registration });
    } catch (err) {
        emit('refused', err);
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
</script>

<template>
    <section :class="['leaf', { root: isRoot, off: !leaf.enabled }]" :data-test="`leaf-${leaf.subcommand || 'root'}`">
        <header v-if="!isRoot" class="leaf-head">
            <button type="button" class="leaf-open" :aria-expanded="open ? 'true' : 'false'" @click="open = !open">
                <Icon :icon="open ? 'material-symbols:expand-less-rounded' : 'material-symbols:expand-more-rounded'" width="16" height="16" aria-hidden="true" />
                <code class="leaf-path">{{ path }}</code>
                <span class="leaf-title">{{ leaf.leafDescription || leaf.title }}</span>
            </button>
            <AppBadge v-if="dirty" size="sm" tone="warn" icon="material-symbols:edit-outline-rounded">
                {{ t('behaviors.card.unsaved') }}
            </AppBadge>
            <AppBadge size="sm">{{ t('behaviors.action.sourceWebhook') }}</AppBadge>
            <AppToggle
                size="sm"
                :model-value="leaf.enabled"
                :disabled="toggling"
                data-test="leaf-toggle"
                :aria-label="t('behaviors.leaf.toggle', { path })"
                @update:model-value="setEnabled"
            />
            <AppMenu placement="bottom-end" :offset="[0, 6]">
                <template #trigger>
                    <button type="button" class="more-btn" :aria-label="t('behaviors.leaf.more', { path })">
                        <Icon icon="material-symbols:more-vert" width="16" height="16" />
                    </button>
                </template>
                <AppMenuItem data-test="leaf-test-fire" @click="testFire">
                    <Icon icon="material-symbols:send-outline-rounded" width="16" height="16" />
                    {{ t('behaviors.card.test') }}
                </AppMenuItem>
                <AppMenuItem danger data-test="leaf-delete" @click="emit('remove', leaf)">
                    <Icon icon="material-symbols:delete-outline-rounded" width="16" height="16" />
                    {{ t('behaviors.leaf.delete') }}
                </AppMenuItem>
            </AppMenu>
        </header>

        <form v-if="open" class="leaf-body" :data-test="`leaf-form-${leaf.subcommand || 'root'}`" @submit.prevent="save">
            <Stack gap="3">
                <WebhookTestResult ref="tester" :behavior-id="leaf.id" target="command" />
                <CommandLeafFields
                    :draft="draft"
                    :kind="kind"
                    :command-name="command.name"
                    :errors="errors.fields"
                    :saved="base.webhook"
                    :behavior-id="leaf.id"
                    :issued-secret="issuedSecret"
                    @patch="applyPatch"
                    @rotated="emit('reload')"
                />

                <div v-if="conflict" class="conflict" role="alert" data-test="leaf-conflict">
                    <span>{{ t('behaviors.card.conflict') }}</span>
                    <AppButton size="sm" variant="secondary" @click="keepMine">{{ t('behaviors.card.conflictKeep') }}</AppButton>
                    <AppButton size="sm" variant="ghost" @click="discard">{{ t('behaviors.card.conflictDiscard') }}</AppButton>
                </div>
                <p v-else-if="stale" class="hint" role="status">{{ t('behaviors.card.staleRebased') }}</p>
                <p v-if="errors.general" class="error" role="alert" data-test="leaf-general-error">{{ errors.general }}</p>

                <footer class="footer">
                    <AppButton variant="secondary" size="sm" class="test" data-test="leaf-test" @click="testFire">
                        {{ t('behaviors.card.test') }}
                    </AppButton>
                    <AppButton variant="secondary" :disabled="!dirty || saving" @click="discard">
                        {{ t('common.cancel') }}
                    </AppButton>
                    <AppButton type="submit" data-test="leaf-save" :loading="saving" :disabled="!canSave">
                        {{ isRoot ? t('behaviors.leaf.saveRoot') : t('behaviors.leaf.save') }}
                    </AppButton>
                </footer>
            </Stack>
        </form>
    </section>
</template>

<style scoped>
.leaf {
    border: 1px solid var(--border);
    border-left: 3px solid var(--accent);
    border-radius: var(--radius-sm);
    background: var(--bg-page);
}
.leaf.root { border-left-color: var(--border); }
.leaf.off { border-left-color: var(--border); opacity: 0.85; }
.leaf-head {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.5rem;
    padding: 0.35rem 0.6rem;
    min-height: 2.5rem;
}
.leaf-open {
    flex: 1;
    min-width: 12rem;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0;
    border: none;
    background: none;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
}
.leaf-path { font-weight: 600; color: var(--text-strong); }
.leaf-title { color: var(--text-muted); font-size: 0.82rem; }
.leaf-body { padding: 0.7rem; border-top: 1px solid var(--border); }
.leaf.root .leaf-body { border-top: none; }
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
.hint { margin: 0; font-size: 0.78rem; color: var(--text-muted); }
.error { margin: 0; font-size: 0.82rem; color: var(--danger); }
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
.footer { display: flex; justify-content: flex-end; flex-wrap: wrap; gap: 0.5rem; }
.footer .test { margin-right: auto; }
</style>

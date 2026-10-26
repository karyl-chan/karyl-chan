<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { AppButton, Cluster, Spacer, Stack, useConfirm } from '@karyl-chan/ui';
import {
    addCommandLeaf,
    deleteBehavior,
    type CommandLeafView,
    type CommandView,
    type RegistrationReport,
} from '../../../api/behavior';
import { ApiError } from '../../../api/client';
import CommandLeafFields from './CommandLeafFields.vue';
import CommandLeafItem from './CommandLeafItem.vue';
import { NO_ERRORS, errorsFromRefusal, type FormErrors } from './behavior-errors';
import { MAX_COMMAND_CHARS, MAX_SUBCOMMANDS, commandCharCount } from './command-rules';
import { checkLeafDraft, leafFieldsWithErrorLine } from './leaf-check';
import { emptyLeafDraft, leafBody, type LeafDraft } from './leaf-draft';
import { hasErrors } from './message-trigger-check';
import { trackUnsavedDraft } from './use-unsaved-drafts';

/**
 * A command's leaves (board 5 「子指令」): the root leaf of a single
 * command, or its subcommands — edited in place, added below, removed
 * from a row's menu. Discord counts subcommands (≤ 25) and the command's
 * characters (≤ 8000); both are shown. A command keeps at least one leaf:
 * removing the last subcommand is deleting the command, and the list
 * says so instead of sending a request the server refuses (invalid_tree).
 * A single command gains subcommands by converting first (board 6).
 */
const props = defineProps<{
    command: CommandView;
}>();

const emit = defineEmits<{
    (e: 'wrote', result: { command: CommandView; registration?: RegistrationReport }): void;
    (e: 'refused', err: unknown): void;
    (e: 'reload'): void;
    /** The admin agreed to delete the whole command (its last leaf went). */
    (e: 'deleteCommand'): void;
    /** A leaf was deleted: what Discord did. */
    (e: 'removed', registration: RegistrationReport): void;
    /** Start board 6: the root leaf becomes the first subcommand. */
    (e: 'convert'): void;
}>();

const { t } = useI18n();
const { confirm } = useConfirm();

const isRoot = computed(() => props.command.leaves.length === 1 && props.command.leaves[0].subcommand === '');
const chars = computed(() => commandCharCount(props.command, props.command.leaves));

// ── remove ──────────────────────────────────────────────────────────────────

async function askDeleteCommand(): Promise<void> {
    const ok = await confirm({
        title: t('behaviors.leaf.lastTitle'),
        message: t('behaviors.leaf.lastMessage', { command: props.command.name }),
        confirmLabel: t('behaviors.command.delete'),
        confirmVariant: 'danger',
        cancelLabel: t('common.cancel'),
    });
    if (ok) emit('deleteCommand');
}

async function remove(leaf: CommandLeafView) {
    if (props.command.leaves.length <= 1) return askDeleteCommand();
    const ok = await confirm({
        title: t('behaviors.leaf.deleteTitle'),
        message: t('behaviors.leaf.deleteMessage', { path: `/${props.command.name} ${leaf.subcommand}` }),
        confirmLabel: t('behaviors.leaf.delete'),
        confirmVariant: 'danger',
        cancelLabel: t('common.cancel'),
    });
    if (!ok) return;
    try {
        const result = await deleteBehavior(leaf.id);
        if (result.registration) emit('removed', result.registration);
        emit('reload');
    } catch (err) {
        // someone removed the other leaves meanwhile: this one is the last
        if (err instanceof ApiError && err.code === 'invalid_tree') {
            emit('reload');
            return askDeleteCommand();
        }
        emit('refused', err);
    }
}

// ── add a subcommand ────────────────────────────────────────────────────────

const adding = ref(false);
const draft = ref<LeafDraft>(emptyLeafDraft());
const errors = ref<FormErrors>(NO_ERRORS);
const creating = ref(false);
/** Secrets the bot generated for leaves added here, shown once in their row. */
const addedSecrets = ref(new Map<number, string>());

const addDirty = computed(() => adding.value && JSON.stringify(draft.value) !== JSON.stringify(emptyLeafDraft()));
trackUnsavedDraft(`new-leaf:${props.command.id}`, addDirty);

function startAdding() {
    if (isRoot.value) {
        emit('convert');
        return;
    }
    draft.value = emptyLeafDraft();
    errors.value = NO_ERRORS;
    adding.value = true;
}

/** Called by the card after a conversion: go straight on to the new subcommand (board 6). */
function openAdd() {
    draft.value = emptyLeafDraft();
    errors.value = NO_ERRORS;
    adding.value = true;
}
defineExpose({ openAdd });

async function create() {
    if (creating.value) return;
    creating.value = true;
    try {
        const found = await checkLeafDraft(t, draft.value, 'add');
        errors.value = found;
        if (hasErrors(found)) return;
        const result = await addCommandLeaf(props.command.id, leafBody(draft.value));
        if (result.secret) addedSecrets.value = new Map(addedSecrets.value).set(result.behavior.id, result.secret);
        adding.value = false;
        emit('wrote', { command: result.command, registration: result.registration });
    } catch (err) {
        if (err instanceof ApiError && err.code === 'registration_failed') {
            errors.value = NO_ERRORS;
            emit('refused', err);
        } else {
            errors.value = errorsFromRefusal(t, err, leafFieldsWithErrorLine(draft.value, 'add'));
        }
    } finally {
        creating.value = false;
    }
}
</script>

<template>
    <Stack gap="2">
        <Cluster gap="2" align="baseline" class="part">
            <h4 class="part-title">{{ isRoot ? t('behaviors.leaf.rootTitle') : t('behaviors.leaf.listTitle') }}</h4>
            <Spacer />
            <span class="counts" data-test="leaf-counts">
                <template v-if="!isRoot">{{ t('behaviors.leaf.count', { count: command.leaves.length, max: MAX_SUBCOMMANDS }) }} · </template>
                <span :class="{ over: chars > MAX_COMMAND_CHARS }">{{ t('behaviors.leaf.chars', { count: chars, max: MAX_COMMAND_CHARS }) }}</span>
            </span>
        </Cluster>

        <CommandLeafItem
            v-for="leaf in command.leaves"
            :key="leaf.id"
            :command="command"
            :leaf="leaf"
            :added-secret="addedSecrets.get(leaf.id) ?? null"
            @wrote="emit('wrote', $event)"
            @refused="emit('refused', $event)"
            @reload="emit('reload')"
            @remove="remove"
        />

        <form v-if="adding" class="add-form" data-test="add-leaf-form" @submit.prevent="create">
            <Stack gap="3">
                <h5 class="add-title">{{ t('behaviors.leaf.addTitle', { command: command.name }) }}</h5>
                <CommandLeafFields
                    :draft="draft"
                    kind="add"
                    :command-name="command.name"
                    :errors="errors.fields"
                    :saved="null"
                    :behavior-id="null"
                    :issued-secret="null"
                    @patch="draft = { ...draft, ...$event }"
                />
                <p v-if="errors.general" class="error" role="alert" data-test="add-leaf-error">{{ errors.general }}</p>
                <footer class="footer">
                    <AppButton variant="secondary" @click="adding = false">{{ t('common.cancel') }}</AppButton>
                    <AppButton type="submit" data-test="add-leaf-create" :loading="creating" :disabled="creating">
                        {{ t('behaviors.leaf.create') }}
                    </AppButton>
                </footer>
            </Stack>
        </form>
        <button
            v-else-if="!isRoot"
            type="button"
            class="add"
            data-test="add-leaf"
            :disabled="!isRoot && command.leaves.length >= MAX_SUBCOMMANDS"
            @click="startAdding"
        >
            ＋ {{ t('behaviors.leaf.add') }}
        </button>
    </Stack>
</template>

<style scoped>
.part {
    margin: 0.2rem 0 0;
    padding-bottom: 0.25rem;
    border-bottom: 1px solid var(--border);
    font-size: 0.78rem;
    font-weight: 600;
    color: var(--text-muted);
}
.part-title { margin: 0; font-size: inherit; font-weight: 600; }
.counts { font-weight: 400; }
.over { color: var(--danger); }
.add-form {
    padding: 0.7rem;
    border: 1px dashed var(--accent);
    border-radius: var(--radius-sm);
}
.add-title { margin: 0; font-size: 0.85rem; color: var(--text-strong); }
.add {
    align-self: flex-start;
    padding: 0.2rem 0;
    border: none;
    background: none;
    color: var(--accent);
    font: inherit;
    font-size: 0.85rem;
    cursor: pointer;
}
.add:disabled { color: var(--text-muted); cursor: not-allowed; }
.hint { margin: 0; font-size: 0.75rem; color: var(--text-muted); }
.error { margin: 0; font-size: 0.82rem; color: var(--danger); }
.footer { display: flex; justify-content: flex-end; gap: 0.5rem; }
</style>

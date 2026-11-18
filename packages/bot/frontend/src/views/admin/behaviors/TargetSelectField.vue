<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { AppSelectField, type SelectOption } from '@karyl-chan/ui';
import type { BehaviorTargetView } from '../../../api/behavior';
import CreateTargetDialog from './CreateTargetDialog.vue';
import { draftTarget, withTarget, type MessageTriggerDraft } from './message-trigger-draft';
import { useTargetDirectory } from './target-directory';
import { targetLabel } from './target-labels';

/**
 * What a message trigger applies to (ADR 0004): one select over the same
 * Behavior Targets the sidebar lists, in the same order. It replaces the
 * location and audience fields — a target says both where and for whom.
 *
 * The draft keeps its own fields (location kind, ids, audience); this
 * field reads the target they add up to and, on a choice, patches them
 * to that target's. "New target…" creates one without leaving the form.
 */
const props = defineProps<{
    draft: MessageTriggerDraft;
    /** Which targets this form may choose (a Service Behavior: bot DMs only). App 指令 never holds a message trigger. */
    allow?: (target: BehaviorTargetView) => boolean;
    error?: string;
}>();

const emit = defineEmits<{ (e: 'patch', patch: Partial<MessageTriggerDraft>): void }>();

const { t } = useI18n();
const directory = useTargetDirectory();

const NEW_TARGET = '\u0000new';

const allowed = (target: BehaviorTargetView) => target.kind !== 'app' && (props.allow?.(target) ?? true);
const choices = computed(() => directory.targets.value.filter(allowed));

/** The key of the target the draft's fields add up to. */
const current = computed(() => draftTarget(props.draft) ?? '');

const options = computed<SelectOption<string>[]>(() => {
    const list: SelectOption<string>[] = choices.value.map((target) => ({
        value: target.key,
        label: targetLabel(t, target, directory.names.value),
    }));
    // a target the list has not heard of yet still shows as what it is
    if (current.value && !list.some((o) => o.value === current.value)) {
        list.unshift({ value: current.value, label: current.value });
    }
    list.push({ value: NEW_TARGET, label: t('behaviors.targetField.new') });
    return list;
});

const creating = ref(false);

function choose(key: string) {
    if (key === NEW_TARGET) {
        creating.value = true;
        return;
    }
    const target = choices.value.find((c) => c.key === key);
    if (target) emit('patch', withTarget(props.draft, target));
}

async function onCreated(target: BehaviorTargetView) {
    await directory.created(target);
    // a kind this form cannot use (a server, for a Service Behavior) is created all the same, just not chosen
    if (allowed(target)) emit('patch', withTarget(props.draft, target));
}
</script>

<template>
    <label class="field">
        <span class="field-label">{{ t('behaviors.targetField.label') }}</span>
        <AppSelectField
            :model-value="current"
            :options="options"
            :placeholder="t('behaviors.targetField.placeholder')"
            :drawer-title="t('behaviors.targetField.label')"
            data-test="target-select"
            filter
            @update:model-value="choose"
        />
        <p v-if="error" class="field-error" data-test="target-error">{{ error }}</p>
    </label>
    <CreateTargetDialog :visible="creating" @close="creating = false" @created="onCreated" />
</template>

<style scoped>
.field { display: flex; flex-direction: column; gap: 0.25rem; min-width: 0; }
.field-label { font-size: 0.75rem; color: var(--text-muted); font-weight: 600; }
.field-error { margin: 0; font-size: 0.75rem; color: var(--danger); }
</style>

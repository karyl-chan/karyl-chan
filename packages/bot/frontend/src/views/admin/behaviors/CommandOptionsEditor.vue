<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { Icon } from '@iconify/vue';
import { AppSelectField, Stack, type SelectOption } from '@karyl-chan/ui';
import { MAX_OPTIONS } from './command-rules';
import { OPTION_TYPES, emptyOption, type OptionDraft, type OptionType } from './leaf-draft';

/**
 * A leaf's command options (board 5 「指令參數」): name, description,
 * type and required, one row each, in the order Discord shows them.
 * Discord wants required options before optional ones, hence the move
 * buttons. Errors arrive by request path (`options.<i>.<field>`).
 */
const props = defineProps<{
    options: OptionDraft[];
    errors: Record<string, string>;
}>();

const emit = defineEmits<{ (e: 'update', options: OptionDraft[]): void }>();

const { t } = useI18n();

const typeOptions = computed<SelectOption<OptionType>[]>(() =>
    OPTION_TYPES.map((type) => ({ value: type, label: t(`behaviors.option.type.${type}`) }))
);

function change(index: number, patch: Partial<OptionDraft>) {
    emit('update', props.options.map((o, i) => (i === index ? { ...o, ...patch } : o)));
}

function remove(index: number) {
    emit('update', props.options.filter((_, i) => i !== index));
}

function move(index: number, to: number) {
    if (to < 0 || to >= props.options.length) return;
    const next = [...props.options];
    const [moved] = next.splice(index, 1);
    next.splice(to, 0, moved);
    emit('update', next);
}

function rowError(index: number): string {
    return ['name', 'description', 'type', 'required']
        .map((f) => props.errors[`options.${index}.${f}`])
        .filter(Boolean)
        .join(' ');
}
</script>

<template>
    <Stack gap="1" class="options" data-test="options">
        <span class="field-label">{{ t('behaviors.option.title') }}</span>
        <p v-if="options.length === 0" class="hint">{{ t('behaviors.option.none') }}</p>
        <Stack v-for="(option, i) in options" :key="i" gap="1">
            <div class="row">
                <input
                    class="input mono"
                    :value="option.name"
                    :aria-label="t('behaviors.option.name')"
                    :placeholder="t('behaviors.option.name')"
                    :aria-invalid="errors[`options.${i}.name`] ? 'true' : undefined"
                    data-test="option-name"
                    @input="change(i, { name: ($event.target as HTMLInputElement).value })"
                />
                <input
                    class="input"
                    :value="option.description"
                    :aria-label="t('behaviors.option.description')"
                    :placeholder="t('behaviors.option.description')"
                    :aria-invalid="errors[`options.${i}.description`] ? 'true' : undefined"
                    data-test="option-description"
                    @input="change(i, { description: ($event.target as HTMLInputElement).value })"
                />
                <AppSelectField
                    :model-value="option.type"
                    :options="typeOptions"
                    :drawer-title="t('behaviors.option.type.label')"
                    @update:model-value="change(i, { type: $event })"
                />
                <label class="check">
                    <input
                        type="checkbox"
                        :checked="option.required"
                        data-test="option-required"
                        @change="change(i, { required: ($event.target as HTMLInputElement).checked })"
                    />
                    {{ t('behaviors.option.required') }}
                </label>
                <span class="tools">
                    <button type="button" class="icon-btn" :disabled="i === 0" :aria-label="t('behaviors.option.moveUp', { name: option.name })" @click="move(i, i - 1)">
                        <Icon icon="material-symbols:arrow-upward-rounded" width="14" height="14" />
                    </button>
                    <button type="button" class="icon-btn" :disabled="i === options.length - 1" :aria-label="t('behaviors.option.moveDown', { name: option.name })" @click="move(i, i + 1)">
                        <Icon icon="material-symbols:arrow-downward-rounded" width="14" height="14" />
                    </button>
                    <button type="button" class="icon-btn" :aria-label="t('behaviors.option.remove', { name: option.name })" data-test="option-remove" @click="remove(i)">
                        <Icon icon="material-symbols:close-rounded" width="14" height="14" />
                    </button>
                </span>
            </div>
            <p v-if="rowError(i)" class="field-error" data-test="option-error">{{ rowError(i) }}</p>
        </Stack>
        <p v-if="errors.options" class="field-error">{{ errors.options }}</p>
        <button
            type="button"
            class="add"
            data-test="option-add"
            :disabled="options.length >= MAX_OPTIONS"
            @click="emit('update', [...options, emptyOption()])"
        >
            ＋ {{ t('behaviors.option.add') }}
        </button>
    </Stack>
</template>

<style scoped>
.options { min-width: 0; }
.field-label { font-size: 0.75rem; color: var(--text-muted); font-weight: 600; }
.hint { margin: 0; font-size: 0.78rem; color: var(--text-muted); }
.row {
    display: grid;
    grid-template-columns: minmax(6rem, 2fr) minmax(8rem, 3fr) minmax(7rem, 2fr) auto auto;
    gap: 0.4rem;
    align-items: center;
}
@media (max-width: 640px) {
    .row { grid-template-columns: 1fr 1fr; }
}
.input {
    min-width: 0;
    height: 2rem;
    padding: 0 0.5rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg-page);
    color: var(--text);
    font: inherit;
    font-size: 0.86rem;
}
.input[aria-invalid='true'] { border-color: var(--danger); }
.mono { font-family: var(--font-mono, ui-monospace, monospace); }
.check { display: inline-flex; align-items: center; gap: 0.35rem; font-size: 0.82rem; white-space: nowrap; cursor: pointer; }
.tools { display: inline-flex; gap: 0.1rem; }
.icon-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 26px;
    height: 26px;
    padding: 0;
    border: none;
    background: none;
    color: var(--text-muted);
    cursor: pointer;
}
.icon-btn:hover:not(:disabled) { color: var(--text); }
.icon-btn:disabled { opacity: 0.35; cursor: default; }
.field-error { margin: 0; font-size: 0.75rem; color: var(--danger); }
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
</style>

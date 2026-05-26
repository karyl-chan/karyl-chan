<script setup lang="ts" generic="V extends string | number | null">
import { computed, useId } from 'vue';

/**
 * Single-line text input with the label + hint + error chrome the
 * admin pages were each re-writing. Use AppTextArea for multi-line.
 *
 * Pass `type="number"` (or other native types) to forward to the
 * underlying `<input>` — the model value is whatever the input
 * coerces to (typically string, since `type="number"` still hands
 * back strings unless the consumer parses).
 *
 * No filter / formatter is built in. Domain transforms (trim, mask,
 * parse number, etc.) stay at the caller; this component owns layout
 * and visual state only.
 */

const props = withDefaults(defineProps<{
    modelValue: V;
    label?: string;
    hint?: string;
    error?: string;
    placeholder?: string;
    disabled?: boolean;
    readonly?: boolean;
    /** Native input type. Default: 'text'. */
    type?: string;
    /** Forward to the underlying input. */
    maxlength?: number;
    /** Visually de-emphasise (e.g. for display-only fields). */
    muted?: boolean;
    /** Grow to fill grid row in a parent `.grid` layout. */
    fullWidth?: boolean;
    /** Tag attribute for the underlying input — useful for forms. */
    name?: string;
    autocomplete?: string;
}>(), {
    label: '',
    hint: '',
    error: '',
    placeholder: '',
    disabled: false,
    readonly: false,
    type: 'text',
    muted: false,
    fullWidth: false,
    name: '',
    autocomplete: 'off'
});

const emit = defineEmits<{
    (e: 'update:modelValue', value: V): void;
    (e: 'blur', ev: FocusEvent): void;
    (e: 'focus', ev: FocusEvent): void;
}>();

const fieldId = useId();

function onInput(e: Event): void {
    const target = e.target as HTMLInputElement;
    emit('update:modelValue', target.value as V);
}

const rootClass = computed(() => ({
    'app-field': true,
    'app-field--full': props.fullWidth,
    'app-field--error': !!props.error
}));
</script>

<template>
    <label :class="rootClass" :for="fieldId">
        <span v-if="label" class="app-field__label">{{ label }}</span>
        <input
            :id="fieldId"
            :class="['app-field__input', { 'app-field__input--muted': muted }]"
            :type="type"
            :value="modelValue"
            :placeholder="placeholder"
            :disabled="disabled"
            :readonly="readonly"
            :maxlength="maxlength"
            :name="name || undefined"
            :autocomplete="autocomplete"
            @input="onInput"
            @blur="emit('blur', $event)"
            @focus="emit('focus', $event)"
        />
        <p v-if="error" class="app-field__error">{{ error }}</p>
        <p v-else-if="hint" class="app-field__hint">{{ hint }}</p>
    </label>
</template>

<style scoped>
.app-field {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    min-width: 0;
}
.app-field--full {
    grid-column: 1 / -1;
}
.app-field__label {
    font-size: 0.75rem;
    color: var(--text-muted);
    font-weight: 600;
}
.app-field__input {
    padding: 0.45rem 0.6rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg-surface);
    color: var(--text);
    font: inherit;
    width: 100%;
    box-sizing: border-box;
}
.app-field__input:focus {
    outline: none;
    border-color: var(--accent);
}
.app-field__input--muted {
    background: var(--bg-page) !important;
    color: var(--text-muted) !important;
    cursor: default;
}
.app-field__input:disabled {
    background: var(--bg-page);
    cursor: not-allowed;
    opacity: 0.7;
}
.app-field__hint {
    margin: 0;
    font-size: 0.72rem;
    color: var(--text-faint, var(--text-muted));
}
.app-field__error {
    margin: 0;
    font-size: 0.75rem;
    color: var(--danger);
}
.app-field--error .app-field__input {
    border-color: var(--danger);
}
</style>

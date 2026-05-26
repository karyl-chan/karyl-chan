<script setup lang="ts">
import { computed, useId } from 'vue';

/**
 * Multi-line counterpart to AppTextField — same label / hint / error
 * chrome, but renders a vertically-resizable `<textarea>` and accepts
 * a `rows` minimum.
 */

const props = withDefaults(defineProps<{
    modelValue: string;
    label?: string;
    hint?: string;
    error?: string;
    placeholder?: string;
    disabled?: boolean;
    readonly?: boolean;
    rows?: number;
    maxlength?: number;
    fullWidth?: boolean;
    name?: string;
}>(), {
    label: '',
    hint: '',
    error: '',
    placeholder: '',
    disabled: false,
    readonly: false,
    rows: 3,
    fullWidth: false,
    name: ''
});

const emit = defineEmits<{
    (e: 'update:modelValue', value: string): void;
    (e: 'blur', ev: FocusEvent): void;
    (e: 'focus', ev: FocusEvent): void;
}>();

const fieldId = useId();

function onInput(e: Event): void {
    const target = e.target as HTMLTextAreaElement;
    emit('update:modelValue', target.value);
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
        <textarea
            :id="fieldId"
            class="app-field__input app-field__input--textarea"
            :value="modelValue"
            :placeholder="placeholder"
            :disabled="disabled"
            :readonly="readonly"
            :rows="rows"
            :maxlength="maxlength"
            :name="name || undefined"
            @input="onInput"
            @blur="emit('blur', $event)"
            @focus="emit('focus', $event)"
        ></textarea>
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
.app-field__input--textarea {
    resize: vertical;
    min-height: 2.5rem;
    font-family: inherit;
}
.app-field__input:focus {
    outline: none;
    border-color: var(--accent);
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

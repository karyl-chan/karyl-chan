<script setup lang="ts">
import { AppToggle } from '@karyl-chan/ui';
import type { PluginConfigField } from '../api/plugins';

/**
 * Shared renderer for a plugin's `config_schema` form fields. Owns ONLY
 * the per-field markup (label + type-switched control + inline error) —
 * the surrounding chrome (load, save, saved badge, stale warning, layout
 * container choice) stays with each caller, because those genuinely
 * differ (plugin-level vs per-guild save, fetched vs in-memory values).
 *
 * Used by PluginDetailConfig (設定 tab), PluginCard (card inline) and
 * GuildBotFeaturesPanel (per-guild). Before this existed the same field
 * switch was copy-pasted three ways and had already drifted (checkbox vs
 * AppToggle, differing input attrs); booleans now render a single way.
 *
 * Values are kept as strings keyed by field key. `values` is the caller's
 * own reactive object — bound by reference and mutated in place, so the
 * caller reads the edits back without an event round-trip. `fieldErrors`
 * maps field key → message (from a 422 ConfigValidationError).
 */
defineProps<{
    schema: PluginConfigField[];
    values: Record<string, string>;
    fieldErrors?: Record<string, string>;
    /** grid: auto-fill columns (detail/card); stack: single column (per-guild row). */
    layout?: 'grid' | 'stack';
}>();
</script>

<template>
    <div class="pcf" :class="layout ?? 'grid'">
        <label
            v-for="field in schema"
            :key="field.key"
            :class="[
                'config-field',
                { full: field.type === 'textarea', 'has-error': !!fieldErrors?.[field.key] },
            ]"
        >
            <span class="config-label">
                {{ field.label }}
                <span v-if="field.required" class="req" aria-hidden="true">*</span>
                <span v-if="field.description" class="hint">{{ field.description }}</span>
            </span>
            <textarea
                v-if="field.type === 'textarea'"
                v-model="values[field.key]"
                rows="3"
                spellcheck="false"
                :maxlength="field.max"
            />
            <select
                v-else-if="field.type === 'select' && field.options"
                v-model="values[field.key]"
            >
                <option value="">—</option>
                <option v-for="opt in field.options" :key="opt.value" :value="opt.value">
                    {{ opt.label }}
                </option>
            </select>
            <AppToggle
                v-else-if="field.type === 'boolean'"
                :model-value="values[field.key] === 'true'"
                :aria-label="field.label || field.key"
                @update:model-value="(v: boolean) => { values[field.key] = v ? 'true' : 'false'; }"
            />
            <input
                v-else
                v-model="values[field.key]"
                :type="field.type === 'secret' ? 'password' : (field.type === 'number' ? 'number' : 'text')"
                :placeholder="field.type === 'secret' ? '留空 = 不變更' : ''"
                autocomplete="off"
                spellcheck="false"
                :min="field.type === 'number' ? field.min : undefined"
                :max="field.type === 'number' ? field.max : undefined"
                :step="field.type === 'number' ? field.step : undefined"
                :maxlength="field.type !== 'number' ? field.max : undefined"
                :pattern="field.pattern"
            />
            <span v-if="fieldErrors?.[field.key]" class="field-error" role="alert">
                {{ fieldErrors[field.key] }}
            </span>
        </label>
    </div>
</template>

<style scoped>
.pcf.grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
    gap: 0.6rem 0.85rem;
}
.pcf.stack {
    display: flex;
    flex-direction: column;
    gap: 0.55rem;
}
.config-field { display: flex; flex-direction: column; gap: 0.25rem; }
.config-field.full { grid-column: 1 / -1; }
.config-label {
    display: flex; flex-direction: column;
    font-size: 0.82rem;
    color: var(--text-strong);
    font-weight: 500;
}
.config-label .req { color: var(--danger); margin-left: 0.2rem; font-weight: 400; }
.config-label .hint { color: var(--text-muted); font-weight: 400; font-size: 0.75rem; margin-top: 0.1rem; }
.config-field input[type="text"],
.config-field input[type="number"],
.config-field input[type="password"],
.config-field textarea,
.config-field select {
    padding: 0.35rem 0.5rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg-surface);
    color: var(--text);
    font-size: 0.85rem;
    font-family: inherit;
    width: 100%;
    box-sizing: border-box;
}
.config-field.has-error input,
.config-field.has-error textarea,
.config-field.has-error select { border-color: var(--danger); }
.config-field :deep(.app-toggle) { align-self: flex-start; margin-top: 0.1rem; }
.field-error { color: var(--danger); font-size: 0.78rem; margin-top: 0.2rem; }
</style>

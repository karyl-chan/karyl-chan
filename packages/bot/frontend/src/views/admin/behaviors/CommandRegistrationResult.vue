<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import { Icon } from '@iconify/vue';
import type { RegistrationResult } from './registration-result';

/**
 * What the last write to a command did on Discord (registration-result.ts):
 * registered per target, deferred with its reason, removed — or the
 * refusal Discord gave, with each target's outcome.
 */
defineProps<{ result: RegistrationResult }>();
const emit = defineEmits<{ (e: 'dismiss'): void }>();

const { t } = useI18n();
const ICONS = {
    ok: 'material-symbols:check-circle-outline-rounded',
    warn: 'material-symbols:schedule-outline-rounded',
    danger: 'material-symbols:error-outline-rounded',
} as const;
</script>

<template>
    <div
        :class="['registration', result.tone]"
        :role="result.tone === 'danger' ? 'alert' : 'status'"
        :data-tone="result.tone"
        data-test="registration-result"
    >
        <p class="headline">
            <Icon :icon="ICONS[result.tone]" width="16" height="16" aria-hidden="true" />
            <span>{{ result.headline }}</span>
            <button type="button" class="dismiss" :aria-label="t('common.close')" @click="emit('dismiss')">
                <Icon icon="material-symbols:close-rounded" width="14" height="14" aria-hidden="true" />
            </button>
        </p>
        <code v-if="result.detail" class="detail">{{ result.detail }}</code>
        <ul v-if="result.targets.length > 0" class="targets">
            <li v-for="(line, i) in result.targets" :key="i">
                <span class="target">{{ line.target }}</span>
                <span>{{ line.text }}</span>
                <code v-if="line.detail" class="detail">{{ line.detail }}</code>
            </li>
        </ul>
    </div>
</template>

<style scoped>
.registration {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    padding: 0.5rem 0.7rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    font-size: 0.85rem;
    overflow-wrap: anywhere;
}
.registration.ok { border-color: var(--success-text, var(--border)); }
.registration.warn { border-color: var(--warn-text, var(--border)); }
.registration.danger { border-color: var(--danger); color: var(--danger); }
.headline { display: flex; align-items: flex-start; gap: 0.4rem; margin: 0; }
.headline > span { flex: 1; }
.dismiss {
    display: inline-flex;
    padding: 0.1rem;
    border: none;
    background: none;
    color: var(--text-muted);
    cursor: pointer;
}
.targets { margin: 0; padding-left: 1.4rem; display: flex; flex-direction: column; gap: 0.15rem; }
.detail { font-size: 0.8rem; margin-left: 0.4rem; }
.target { font-weight: 600; margin-right: 0.4rem; }
</style>

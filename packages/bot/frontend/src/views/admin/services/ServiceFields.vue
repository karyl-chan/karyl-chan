<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import { AppTextField } from '@karyl-chan/ui';
import type { ServiceInput } from '../../../api/services';

/** A service's three settings — shared by the add form and a row's edit. */
defineProps<{
    draft: ServiceInput;
    errors: Partial<Record<keyof ServiceInput, string>>;
}>();

const emit = defineEmits<{ (e: 'patch', patch: Partial<ServiceInput>): void }>();

const { t } = useI18n();
</script>

<template>
    <div class="grid">
        <AppTextField
            :model-value="draft.name"
            :label="t('services.field.name')"
            :error="errors.name"
            data-test="service-name"
            @update:model-value="emit('patch', { name: String($event) })"
        />
        <AppTextField
            class="mono"
            :model-value="draft.audience"
            :label="t('services.field.audience')"
            :hint="t('services.field.audienceHint')"
            :error="errors.audience"
            data-test="service-audience"
            @update:model-value="emit('patch', { audience: String($event) })"
        />
        <AppTextField
            class="mono wide"
            :model-value="draft.redirectUrl"
            :label="t('services.field.redirectUrl')"
            :hint="t('services.field.redirectUrlHint')"
            :error="errors.redirectUrl"
            placeholder="https://"
            data-test="service-redirect"
            @update:model-value="emit('patch', { redirectUrl: String($event) })"
        />
    </div>
</template>

<style scoped>
.grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr));
    gap: 0.6rem 1rem;
}
.wide { grid-column: 1 / -1; }
.mono :deep(input) { font-family: var(--font-mono, ui-monospace, monospace); }
</style>

<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import { AppTextField, Stack } from '@karyl-chan/ui';
import type { WebhookActionView } from '../../../api/behavior';
import CommandOptionsEditor from './CommandOptionsEditor.vue';
import WebhookActionFields from './WebhookActionFields.vue';
import type { LeafFormKind } from './leaf-check';
import type { LeafDraft } from './leaf-draft';

/**
 * The fields of one Command Leaf (board 5, inside a subcommand row): the
 * subcommand's name and Discord description (not for the root leaf — the
 * command itself is that), the title and admin note, the options, and
 * the webhook action. Shared by a saved leaf's editor and the "add a
 * subcommand" form.
 */
defineProps<{
    draft: LeafDraft;
    kind: LeafFormKind;
    commandName: string;
    errors: Record<string, string>;
    /** The saved webhook (null while adding). */
    saved: WebhookActionView | null;
    behaviorId: number | null;
    issuedSecret: string | null;
}>();

const emit = defineEmits<{
    (e: 'patch', patch: Partial<LeafDraft>): void;
    (e: 'rotated'): void;
}>();

const { t } = useI18n();
</script>

<template>
    <Stack gap="3">
        <div v-if="kind !== 'root'" class="grid">
            <AppTextField
                class="mono"
                :model-value="draft.subcommand"
                :label="t('behaviors.leaf.subcommand', { command: commandName })"
                :hint="t('behaviors.command.nameHint')"
                :error="errors.subcommand"
                data-test="leaf-subcommand"
                @update:model-value="emit('patch', { subcommand: String($event) })"
            />
            <AppTextField
                :model-value="draft.leafDescription"
                :label="t('behaviors.leaf.leafDescription')"
                :placeholder="draft.title"
                :hint="t('behaviors.leaf.leafDescriptionHint')"
                :error="errors.leafDescription"
                @update:model-value="emit('patch', { leafDescription: String($event) })"
            />
        </div>
        <div class="grid">
            <AppTextField
                :model-value="draft.title"
                :label="t('behaviors.card.titleLabel')"
                :hint="kind === 'root' ? undefined : t('behaviors.leaf.titleHint')"
                :error="errors.title"
                data-test="leaf-title"
                @update:model-value="emit('patch', { title: String($event) })"
            />
            <AppTextField
                :model-value="draft.description"
                :label="t('behaviors.card.descriptionLabel')"
                :hint="t('behaviors.card.descriptionHint')"
                :error="errors.description"
                @update:model-value="emit('patch', { description: String($event) })"
            />
        </div>
        <CommandOptionsEditor :options="draft.options" :errors="errors" @update="emit('patch', { options: $event })" />
        <WebhookActionFields
            :draft="draft"
            :errors="errors"
            :saved="saved"
            :behavior-id="behaviorId"
            :issued-secret="issuedSecret"
            @patch="emit('patch', $event)"
            @rotated="emit('rotated')"
        />
    </Stack>
</template>

<style scoped>
.grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr));
    gap: 0.6rem 1rem;
}
.mono :deep(input) { font-family: var(--font-mono, ui-monospace, monospace); }
</style>

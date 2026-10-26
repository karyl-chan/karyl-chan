<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Icon } from '@iconify/vue';
import { AppButton, AppModal, AppTextField, Stack } from '@karyl-chan/ui';
import {
    convertToSubcommands,
    getBehaviorSchemas,
    type CommandView,
    type RegistrationReport,
} from '../../../api/behavior';
import { ApiError } from '../../../api/client';
import CommandRegistrationResult from './CommandRegistrationResult.vue';
import { checkAgainstSchema, issueMessage, type JsonSchema } from './form-schema';
import { registrationFailure, type RegistrationResult } from './registration-result';

/**
 * Board 6: a single command gains subcommands. Discord does not let a
 * command with subcommands be run itself, so its current action first
 * moves one level down under a subcommand name the admin picks
 * (POST /api/behavior-commands/:id/convert-to-subcommands); the
 * visibility stays as it is. Then the card goes on to the new subcommand.
 */
const props = defineProps<{
    visible: boolean;
    command: CommandView;
    guildNames: ReadonlyMap<string, string>;
}>();

const emit = defineEmits<{
    (e: 'close'): void;
    (e: 'converted', result: { command: CommandView; registration: RegistrationReport }): void;
}>();

const { t } = useI18n();

const name = ref('');
const nameSchema = ref<JsonSchema | null>(null);
const converting = ref(false);
const refusal = ref<RegistrationResult | null>(null);
/** The server's refusal of the name itself (taken, malformed) — shown on the field. */
const serverNameError = ref<string | null>(null);
watch(name, () => (serverNameError.value = null));

watch(
    () => props.visible,
    async (visible) => {
        if (!visible) return;
        name.value = '';
        refusal.value = null;
        serverNameError.value = null;
        const schemas = await getBehaviorSchemas().catch(() => null);
        const properties = schemas?.commandLeaf?.properties as Record<string, JsonSchema> | undefined;
        nameSchema.value = properties?.subcommand ?? null;
    },
    { immediate: true }
);

/** The name against the server's own subcommand schema; without it, only "not empty". */
const nameError = computed(() => {
    const value = name.value.trim();
    if (value === '') return null;
    if (serverNameError.value) return serverNameError.value;
    if (!nameSchema.value) return null;
    const issue = checkAgainstSchema(nameSchema.value, value)[''];
    return issue ? issueMessage(t, issue) : null;
});
const valid = computed(() => name.value.trim() !== '' && nameError.value === null);

const root = computed(() => props.command.leaves[0]);
const action = computed(() => {
    const url = root.value?.webhook?.url;
    if (!url) return t('behaviors.action.sourceWebhook');
    try {
        return `${t('behaviors.action.sourceWebhook')} · ${new URL(url).host}`;
    } catch {
        return t('behaviors.action.sourceWebhook');
    }
});

async function convert() {
    if (!valid.value || converting.value) return;
    converting.value = true;
    refusal.value = null;
    try {
        const result = await convertToSubcommands(props.command.id, { subcommand: name.value.trim() });
        emit('converted', result);
    } catch (err) {
        if (err instanceof ApiError && err.field === 'subcommand') serverNameError.value = err.message;
        else refusal.value = registrationFailure(t, err, props.guildNames);
    } finally {
        converting.value = false;
    }
}
</script>

<template>
    <AppModal
        :visible="visible"
        :title="t('behaviors.convert.title', { command: command.name })"
        :close-label="t('common.close')"
        width="min(680px, 95vw)"
        @close="emit('close')"
    >
        <form class="convert" data-test="convert-dialog" @submit.prevent="convert">
            <Stack gap="4">
                <p class="intro">{{ t('behaviors.convert.intro', { command: command.name }) }}</p>

                <AppTextField
                    v-model="name"
                    class="mono name"
                    data-test="convert-name"
                    :label="t('behaviors.convert.name')"
                    :hint="t('behaviors.command.nameHint')"
                    :error="nameError ?? undefined"
                    autofocus
                />

                <div class="compare">
                    <div class="box">
                        <span class="box-label">{{ t('behaviors.convert.now') }}</span>
                        <code class="path">/{{ command.name }}</code>
                        <span class="muted">{{ action }}</span>
                    </div>
                    <div class="box after" data-test="convert-after">
                        <span class="box-label">{{ t('behaviors.convert.after') }}</span>
                        <code class="path">/{{ command.name }} {{ valid ? name.trim() : '…' }}</code>
                        <span class="muted">{{ action }} {{ t('behaviors.convert.sameAction') }}</span>
                        <div class="next">
                            <code class="path muted">/{{ command.name }} ＿＿＿</code>
                            <span class="muted">{{ t('behaviors.convert.nextLeaf') }}</span>
                        </div>
                    </div>
                </div>

                <p class="note" role="note">
                    <Icon icon="material-symbols:warning-outline-rounded" width="16" height="16" aria-hidden="true" />
                    <span>{{ t('behaviors.convert.note', { command: command.name }) }}</span>
                </p>

                <CommandRegistrationResult v-if="refusal" :result="refusal" @dismiss="refusal = null" />

                <footer class="footer">
                    <AppButton variant="secondary" @click="emit('close')">{{ t('common.cancel') }}</AppButton>
                    <AppButton type="submit" data-test="convert-submit" :loading="converting" :disabled="!valid || converting">
                        {{ t('behaviors.convert.submit') }}
                    </AppButton>
                </footer>
            </Stack>
        </form>
    </AppModal>
</template>

<style scoped>
.intro { margin: 0; color: var(--text-muted); line-height: 1.6; font-size: 0.9rem; }
.mono :deep(input) { font-family: var(--font-mono, ui-monospace, monospace); }
.name { max-width: 22rem; }
.compare {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr));
    gap: 0.75rem;
}
.box {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    padding: 0.7rem 0.85rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg-page);
}
.box.after { border-color: var(--accent); }
.box-label { font-size: 0.75rem; font-weight: 600; color: var(--text-muted); margin-bottom: 0.3rem; }
.path { color: var(--text-strong); }
.muted { color: var(--text-muted); font-size: 0.8rem; }
.next {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    margin-top: 0.5rem;
    padding-top: 0.5rem;
    border-top: 1px dashed var(--border);
}
.note {
    display: flex;
    align-items: flex-start;
    gap: 0.5rem;
    margin: 0;
    padding: 0.6rem 0.8rem;
    border: 1px solid var(--warn-text, var(--border));
    border-radius: var(--radius-sm);
    color: var(--warn-text, var(--text));
    font-size: 0.85rem;
    line-height: 1.6;
}
.note > svg { flex: none; margin-top: 0.2rem; }
.footer { display: flex; justify-content: flex-end; gap: 0.5rem; }
</style>

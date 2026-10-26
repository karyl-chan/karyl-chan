<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { AppSelectField, AppTextField, Stack, type SelectOption } from '@karyl-chan/ui';
import type { BehaviorSection } from '../../../api/behavior';
import { useGuildListStore } from '../../../stores/guildListStore';
import { draftSection, withRegistration, type CommandDraft } from './command-draft';
import type { CommandContext, CommandIntegrationType } from './command-rules';
import { sectionLabel } from './section-labels';

/**
 * A Command's visibility (board 5 「可見性」): where it is registered —
 * everywhere, or one server — who installs it, where it can be used and
 * the default member permissions. Shows, while the admin edits, which
 * Behavior Section the command lands in (command-rules.ts, the pinned
 * mirror of the server's rule) and Discord's rules as errors on the
 * field they concern. A server command can only be used in its server and
 * installed by it, so those choices are fixed there.
 *
 * `globalOnly` (the system login's command): registered everywhere with
 * no default member permissions — the server fixes both — so only the
 * installs and contexts are offered. `required` keeps some of those ticked
 * and locked (the login command's guild install and bot DMs), with
 * `requiredReason` as their tooltip.
 */
const props = defineProps<{
    draft: CommandDraft;
    errors: Record<string, string>;
    /** The section the saved command is in (null while creating). */
    section: BehaviorSection | null;
    guildNames: ReadonlyMap<string, string>;
    globalOnly?: boolean;
    required?: {
        integrationTypes?: readonly CommandIntegrationType[];
        contexts?: readonly CommandContext[];
    };
    requiredReason?: string;
}>();

const emit = defineEmits<{ (e: 'patch', patch: Partial<CommandDraft>): void }>();

const { t } = useI18n();
const guildList = useGuildListStore();

const isGuild = computed(() => props.draft.registration === 'guild');

const registrationOptions = computed<SelectOption<'global' | 'guild'>[]>(() =>
    (['global', 'guild'] as const).map((r) => ({ value: r, label: t(`behaviors.command.registration.${r}`) }))
);

function setRegistration(registration: 'global' | 'guild') {
    emit('patch', withRegistration(props.draft, registration));
}

const guildOptions = computed<SelectOption<string>[]>(() => {
    const options = guildList.guilds.map((g) => ({ value: g.id, label: g.name }));
    const current = props.draft.guildId;
    if (current && !options.some((o) => o.value === current)) options.unshift({ value: current, label: current });
    return options;
});

/** Discord permission bits the board offers; any other saved value is kept as it is. */
const PERMISSION_PRESETS = [
    { value: '', key: 'everyone' },
    { value: '32', key: 'manageGuild' },
    { value: '8', key: 'administrator' },
] as const;

const permissionOptions = computed<SelectOption<string>[]>(() => {
    const options: SelectOption<string>[] = PERMISSION_PRESETS.map((p) => ({
        value: p.value,
        label: t(`behaviors.command.permissions.${p.key}`),
    }));
    const current = props.draft.defaultMemberPermissions;
    if (!options.some((o) => o.value === current)) {
        options.push({ value: current, label: t('behaviors.command.permissions.custom', { value: current }) });
    }
    return options;
});

const INSTALLS: readonly CommandIntegrationType[] = ['guild_install', 'user_install'];
const CONTEXTS: readonly CommandContext[] = ['Guild', 'BotDM', 'PrivateChannel'];

function toggle<T extends string>(list: readonly T[], item: T, on: boolean, order: readonly T[]): T[] {
    const next = new Set(list);
    if (on) next.add(item);
    else next.delete(item);
    return order.filter((x) => next.has(x));
}

/** Where saving puts the command, said before it is saved (board 5). */
const sectionHint = computed(() => {
    const target = draftSection(props.draft);
    if (target === null) return t('behaviors.command.sectionPending');
    const label = sectionLabel(t, target, props.guildNames);
    return props.section === null || target === props.section
        ? t('behaviors.command.sectionHere', { section: label })
        : t('behaviors.command.sectionMoves', { section: label });
});
</script>

<template>
    <Stack gap="2">
        <h4 class="part">{{ t('behaviors.command.visibility') }}</h4>
        <div v-if="!globalOnly" class="grid">
            <label class="field">
                <Stack gap="1">
                    <span class="field-label">{{ t('behaviors.command.registration.label') }}</span>
                    <AppSelectField
                        :model-value="draft.registration"
                        :options="registrationOptions"
                        :drawer-title="t('behaviors.command.registration.label')"
                        @update:model-value="setRegistration"
                    />
                    <p v-if="errors.registration" class="field-error">{{ errors.registration }}</p>
                </Stack>
            </label>
            <template v-if="isGuild">
                <label v-if="guildList.guilds.length > 0" class="field">
                    <Stack gap="1">
                        <span class="field-label">{{ t('behaviors.location.guildPicker') }}</span>
                        <AppSelectField
                            :model-value="draft.guildId"
                            :options="guildOptions"
                            :placeholder="t('behaviors.location.guildPlaceholder')"
                            :drawer-title="t('behaviors.location.guildPicker')"
                            filter
                            @update:model-value="emit('patch', { guildId: $event })"
                        />
                        <p v-if="errors.guildId" class="field-error">{{ errors.guildId }}</p>
                    </Stack>
                </label>
                <AppTextField
                    v-else
                    :model-value="draft.guildId"
                    :label="t('behaviors.location.guildPicker')"
                    :hint="t('behaviors.location.idHint')"
                    :error="errors.guildId"
                    inputmode="numeric"
                    @update:model-value="emit('patch', { guildId: String($event) })"
                />
            </template>
            <label class="field">
                <Stack gap="1">
                    <span class="field-label">{{ t('behaviors.command.permissions.label') }}</span>
                    <AppSelectField
                        :model-value="draft.defaultMemberPermissions"
                        :options="permissionOptions"
                        :drawer-title="t('behaviors.command.permissions.label')"
                        @update:model-value="emit('patch', { defaultMemberPermissions: $event })"
                    />
                    <p v-if="errors.defaultMemberPermissions" class="field-error">{{ errors.defaultMemberPermissions }}</p>
                </Stack>
            </label>
        </div>

        <div class="grid">
            <fieldset class="checks" :disabled="isGuild" data-test="integration-types">
                <legend class="field-label">{{ t('behaviors.card.integrationTypes') }}</legend>
                <div class="row">
                    <label v-for="i in INSTALLS" :key="i" class="check" :title="required?.integrationTypes?.includes(i) ? requiredReason : undefined">
                        <input
                            type="checkbox"
                            :checked="draft.integrationTypes.includes(i)"
                            :disabled="required?.integrationTypes?.includes(i)"
                            @change="emit('patch', { integrationTypes: toggle(draft.integrationTypes, i, ($event.target as HTMLInputElement).checked, INSTALLS) })"
                        />
                        {{ t(`behaviors.card.integration.${i}`) }}
                    </label>
                </div>
                <p v-if="errors.integrationTypes" class="field-error">{{ errors.integrationTypes }}</p>
            </fieldset>
            <fieldset class="checks" :disabled="isGuild" data-test="contexts">
                <legend class="field-label">{{ t('behaviors.card.contexts') }}</legend>
                <div class="row">
                    <label v-for="c in CONTEXTS" :key="c" class="check" :title="required?.contexts?.includes(c) ? requiredReason : undefined">
                        <input
                            type="checkbox"
                            :checked="draft.contexts.includes(c)"
                            :disabled="required?.contexts?.includes(c)"
                            @change="emit('patch', { contexts: toggle(draft.contexts, c, ($event.target as HTMLInputElement).checked, CONTEXTS) })"
                        />
                        {{ t(`behaviors.card.context.${c}`) }}
                    </label>
                </div>
                <p v-if="errors.contexts" class="field-error">{{ errors.contexts }}</p>
            </fieldset>
        </div>
        <p v-if="isGuild" class="hint">{{ t('behaviors.command.guildFixed') }}</p>

        <div class="section-hint" role="status" data-test="section-hint">
            <span class="where">{{ sectionHint }}</span>
            <span class="hint">{{ t('behaviors.command.visibleRuns') }}</span>
        </div>
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
.grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr));
    gap: 0.6rem 1rem;
    align-items: start;
}
.field { display: block; min-width: 0; }
.field-label { font-size: 0.75rem; color: var(--text-muted); font-weight: 600; }
.field-error { margin: 0; font-size: 0.75rem; color: var(--danger); }
.checks { border: 0; margin: 0; padding: 0; min-width: 0; display: flex; flex-direction: column; gap: 0.25rem; }
.checks:disabled { opacity: 0.5; }
.checks legend { padding: 0; margin-bottom: 0.25rem; }
.row { display: flex; flex-wrap: wrap; gap: 0.25rem 1rem; }
.check { display: inline-flex; align-items: center; gap: 0.4rem; font-size: 0.86rem; min-height: 1.75rem; cursor: pointer; }
.checks:disabled .check { cursor: not-allowed; }
.hint { margin: 0; font-size: 0.75rem; color: var(--text-muted); }
.section-hint {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    padding: 0.5rem 0.7rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg-page);
}
.where { font-size: 0.85rem; color: var(--text-strong); }
</style>

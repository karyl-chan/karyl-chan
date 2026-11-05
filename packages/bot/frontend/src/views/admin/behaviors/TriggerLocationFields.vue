<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { AppSelectField, AppTextField, type SelectOption } from '@karyl-chan/ui';
import { listGuildTextChannels, type GuildChannelCategory } from '../../../api/guilds';
import { useGuildListStore } from '../../../stores/guildListStore';
import { withLocationKind, type MessageTriggerDraft } from './message-trigger-draft';
import { kindHasGuild, type LocationKind } from './message-trigger-location';

/**
 * Where a Message Trigger is: bot DMs, every guild, one guild or one
 * channel. Guilds and channels are picked from what the bot can see;
 * without guild access the fields take raw ids.
 */
const props = defineProps<{
    draft: MessageTriggerDraft;
    /** The kinds of location this form may choose; one = fixed. */
    kinds: readonly LocationKind[];
    /** The guild / channel is fixed by the section the trigger is created in. */
    lockGuild?: boolean;
    lockChannel?: boolean;
    errors: Record<string, string>;
}>();

const emit = defineEmits<{ (e: 'patch', patch: Partial<MessageTriggerDraft>): void }>();

const { t } = useI18n();
const guildList = useGuildListStore();

function update(patch: Partial<MessageTriggerDraft>) {
    emit('patch', patch);
}

const kind = computed({
    get: () => props.draft.locationKind,
    set: (next: LocationKind) => emit('patch', withLocationKind(props.draft, next)),
});

const kindOptions = computed<SelectOption<LocationKind>[]>(() =>
    props.kinds.map((k) => ({ value: k, label: t(`behaviors.location.${k}`) }))
);

const needsGuild = computed(() => kindHasGuild(kind.value));

function guildLabel(id: string): string {
    return guildList.guilds.find((g) => g.id === id)?.name ?? id;
}

const guildOptions = computed<SelectOption<string>[]>(() => {
    const options = guildList.guilds.map((g) => ({ value: g.id, label: g.name }));
    const current = props.draft.guildId;
    if (current && !options.some((o) => o.value === current)) options.unshift({ value: current, label: current });
    return options;
});

const categories = ref<GuildChannelCategory[]>([]);
watch(
    () => (kind.value === 'channel' ? props.draft.guildId : ''),
    async (guildId) => {
        categories.value = [];
        if (!/^\d{17,20}$/.test(guildId)) return;
        try {
            categories.value = await listGuildTextChannels(guildId);
        } catch {
            // without guild access the channel is typed as an id
        }
    },
    { immediate: true }
);

function channelLabel(id: string): string {
    return channelOptions.value.find((o) => o.value === id && o.label !== id)?.label ?? `#${id}`;
}

const channelOptions = computed<SelectOption<string>[]>(() => {
    const options: SelectOption<string>[] = [];
    for (const cat of categories.value) {
        for (const ch of cat.channels) {
            if (ch.kind === 'text') options.push({ value: ch.id, label: `#${ch.name}`, group: cat.name });
        }
    }
    const current = props.draft.channelId;
    if (current && !options.some((o) => o.value === current)) options.unshift({ value: current, label: current });
    return options;
});
</script>

<template>
    <div class="location">
        <label v-if="kinds.length > 1" class="field">
            <span class="field-label">{{ t('behaviors.location.label') }}</span>
            <AppSelectField v-model="kind" :options="kindOptions" :drawer-title="t('behaviors.location.label')" />
            <p v-if="errors.surface" class="field-error">{{ errors.surface }}</p>
        </label>
        <div v-else class="field">
            <span class="field-label">{{ t('behaviors.location.label') }}</span>
            <span class="fixed">{{ t(`behaviors.location.${kind}`) }}</span>
        </div>

        <div v-if="needsGuild" class="pickers">
            <div v-if="lockGuild" class="field">
                <span class="field-label">{{ t('behaviors.location.guildPicker') }}</span>
                <span class="fixed">{{ guildLabel(draft.guildId) }}</span>
            </div>
            <label v-else-if="guildList.guilds.length > 0" class="field">
                <span class="field-label">{{ t('behaviors.location.guildPicker') }}</span>
                <AppSelectField
                    :model-value="draft.guildId"
                    :options="guildOptions"
                    :placeholder="t('behaviors.location.guildPlaceholder')"
                    :drawer-title="t('behaviors.location.guildPicker')"
                    filter
                    @update:model-value="update({ guildId: $event, channelId: '' })"
                />
                <p v-if="errors.guildId" class="field-error">{{ errors.guildId }}</p>
            </label>
            <AppTextField
                v-else
                :model-value="draft.guildId"
                :label="t('behaviors.location.guildPicker')"
                :hint="t('behaviors.location.idHint')"
                :error="errors.guildId"
                inputmode="numeric"
                @update:model-value="update({ guildId: String($event), channelId: '' })"
            />

            <template v-if="kind === 'channel'">
                <div v-if="lockChannel" class="field">
                    <span class="field-label">{{ t('behaviors.location.channelPicker') }}</span>
                    <span class="fixed">{{ channelLabel(draft.channelId) }}</span>
                </div>
                <label v-else-if="channelOptions.length > 0" class="field">
                    <span class="field-label">{{ t('behaviors.location.channelPicker') }}</span>
                    <AppSelectField
                        :model-value="draft.channelId"
                        :options="channelOptions"
                        :placeholder="t('behaviors.location.channelPlaceholder')"
                        :drawer-title="t('behaviors.location.channelPicker')"
                        filter
                        @update:model-value="update({ channelId: $event })"
                    />
                    <p v-if="errors.channelId" class="field-error">{{ errors.channelId }}</p>
                </label>
                <AppTextField
                    v-else
                    :model-value="draft.channelId"
                    :label="t('behaviors.location.channelPicker')"
                    :hint="t('behaviors.location.idHint')"
                    :error="errors.channelId"
                    inputmode="numeric"
                    @update:model-value="update({ channelId: String($event) })"
                />
            </template>
        </div>
    </div>
</template>

<style scoped>
.location {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr));
    gap: 0.6rem 1rem;
}
.pickers {
    display: flex;
    gap: 0.5rem;
    min-width: 0;
}
.pickers > * { flex: 1; min-width: 0; }
.field { display: flex; flex-direction: column; gap: 0.25rem; min-width: 0; }
.field-label { font-size: 0.75rem; color: var(--text-muted); font-weight: 600; }
.field-error { margin: 0; font-size: 0.75rem; color: var(--danger); }
.fixed { font-size: 0.9rem; color: var(--text-strong); padding: 0.4rem 0; }
</style>

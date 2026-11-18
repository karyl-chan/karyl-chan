<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { AppSelectField, AppTextField, type SelectOption } from '@karyl-chan/ui';
import { listGuildTextChannels, type GuildChannelCategory } from '../../../api/guilds';
import { useGuildListStore } from '../../../stores/guildListStore';

/**
 * The server — and, for a channel, the channel — of a new Behavior Target.
 * Both are picked from what the bot can see; without guild access the
 * fields take raw ids.
 */
const props = defineProps<{
    kind: 'guild' | 'channel';
    guildId: string;
    channelId: string;
    errors: Record<string, string>;
}>();

const emit = defineEmits<{ (e: 'patch', patch: { guildId?: string; channelId?: string }): void }>();

const { t } = useI18n();
const guildList = useGuildListStore();
void guildList.ensure().catch(() => undefined);

const guildOptions = computed<SelectOption<string>[]>(() => {
    const options = guildList.guilds.map((g) => ({ value: g.id, label: g.name }));
    if (props.guildId && !options.some((o) => o.value === props.guildId)) {
        options.unshift({ value: props.guildId, label: props.guildId });
    }
    return options;
});

const categories = ref<GuildChannelCategory[]>([]);
watch(
    () => (props.kind === 'channel' ? props.guildId : ''),
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

const channelOptions = computed<SelectOption<string>[]>(() => {
    const options: SelectOption<string>[] = [];
    for (const cat of categories.value) {
        for (const ch of cat.channels) {
            if (ch.kind === 'text') options.push({ value: ch.id, label: `#${ch.name}`, group: cat.name });
        }
    }
    if (props.channelId && !options.some((o) => o.value === props.channelId)) {
        options.unshift({ value: props.channelId, label: props.channelId });
    }
    return options;
});
</script>

<template>
    <div class="pickers">
        <label v-if="guildList.guilds.length > 0" class="field">
            <span class="field-label">{{ t('behaviors.location.guildPicker') }}</span>
            <AppSelectField
                :model-value="guildId"
                :options="guildOptions"
                :placeholder="t('behaviors.location.guildPlaceholder')"
                :drawer-title="t('behaviors.location.guildPicker')"
                filter
                @update:model-value="emit('patch', { guildId: $event, channelId: '' })"
            />
            <p v-if="errors.guildId" class="field-error">{{ errors.guildId }}</p>
        </label>
        <AppTextField
            v-else
            :model-value="guildId"
            :label="t('behaviors.location.guildPicker')"
            :hint="t('behaviors.location.idHint')"
            :error="errors.guildId"
            inputmode="numeric"
            @update:model-value="emit('patch', { guildId: String($event), channelId: '' })"
        />

        <template v-if="kind === 'channel'">
            <label v-if="channelOptions.length > 0" class="field">
                <span class="field-label">{{ t('behaviors.location.channelPicker') }}</span>
                <AppSelectField
                    :model-value="channelId"
                    :options="channelOptions"
                    :placeholder="t('behaviors.location.channelPlaceholder')"
                    :drawer-title="t('behaviors.location.channelPicker')"
                    filter
                    @update:model-value="emit('patch', { channelId: $event })"
                />
                <p v-if="errors.channelId" class="field-error">{{ errors.channelId }}</p>
            </label>
            <AppTextField
                v-else
                :model-value="channelId"
                :label="t('behaviors.location.channelPicker')"
                :hint="t('behaviors.location.idHint')"
                :error="errors.channelId"
                inputmode="numeric"
                @update:model-value="emit('patch', { channelId: String($event) })"
            />
        </template>
    </div>
</template>

<style scoped>
.pickers {
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
    min-width: 0;
}
.field { display: flex; flex-direction: column; gap: 0.25rem; min-width: 0; }
.field-label { font-size: 0.75rem; color: var(--text-muted); font-weight: 600; }
.field-error { margin: 0; font-size: 0.75rem; color: var(--danger); }
</style>

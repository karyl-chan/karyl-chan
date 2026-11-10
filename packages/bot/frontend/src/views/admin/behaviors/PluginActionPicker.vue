<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { AppSelectField, type SelectOption } from '@karyl-chan/ui';
import { getPluginBehaviorActions, type PluginBehaviorActions } from '../../../api/behavior';

/**
 * Picks a plugin action (#203): one of the behavior actions the installed
 * plugins declare in their manifests (GET /api/behaviors/plugin-actions),
 * grouped by plugin. A disabled or offline plugin's actions can still be
 * picked — the behavior fails until the plugin is back, and the picker
 * says so; a binding to an action its plugin no longer declares stays
 * shown, marked, so saving something else is a choice.
 */
const props = defineProps<{
    pluginKey: string;
    actionKey: string;
    /** `pluginAction.pluginKey` / `pluginAction.actionKey` / `pluginAction` refusals. */
    error?: string;
}>();

const emit = defineEmits<{
    (e: 'pick', value: { pluginKey: string; actionKey: string }): void;
}>();

const { t } = useI18n();

const plugins = ref<PluginBehaviorActions[] | null>(null);
const loadFailed = ref(false);

onMounted(async () => {
    try {
        plugins.value = await getPluginBehaviorActions();
    } catch {
        loadFailed.value = true;
    }
});

const SEP = '\u0000';
const valueOf = (pluginKey: string, actionKey: string) => `${pluginKey}${SEP}${actionKey}`;

const current = computed(() => (props.pluginKey && props.actionKey ? valueOf(props.pluginKey, props.actionKey) : ''));
const plugin = computed(() => plugins.value?.find((p) => p.pluginKey === props.pluginKey) ?? null);
const action = computed(() => plugin.value?.actions.find((a) => a.key === props.actionKey) ?? null);
/** The binding names an action its plugin (no longer) declares. */
const undeclared = computed(() => plugins.value !== null && current.value !== '' && action.value === null);
const offline = computed(() => plugin.value !== null && (!plugin.value.enabled || plugin.value.status !== 'active'));

const options = computed<SelectOption<string>[]>(() => {
    const list: SelectOption<string>[] = (plugins.value ?? []).flatMap((p) =>
        p.actions.map((a) => ({ value: valueOf(p.pluginKey, a.key), label: a.name, group: p.pluginName }))
    );
    if (undeclared.value) {
        list.unshift({
            value: current.value,
            label: t('behaviors.action.plugin.undeclaredOption', { plugin: props.pluginKey, action: props.actionKey }),
            group: null,
        });
    }
    return list;
});

function pick(value: string) {
    const [pluginKey = '', actionKey = ''] = value.split(SEP);
    emit('pick', { pluginKey, actionKey });
}
</script>

<template>
    <label class="field" data-test="plugin-action-picker">
        <span class="field-label">{{ t('behaviors.action.plugin.label') }}</span>
        <p v-if="loadFailed" class="field-error" role="alert" data-test="plugin-actions-failed">
            {{ t('behaviors.action.plugin.loadFailed') }}
        </p>
        <span v-else-if="plugins === null" class="field-hint">{{ t('behaviors.action.plugin.loading') }}</span>
        <span v-else-if="options.length === 0" class="field-hint" data-test="plugin-actions-none">
            {{ t('behaviors.action.plugin.none') }}
        </span>
        <AppSelectField
            v-else
            :model-value="current"
            :options="options"
            :placeholder="t('behaviors.action.plugin.placeholder')"
            :drawer-title="t('behaviors.action.plugin.label')"
            data-test="plugin-action-select"
            @update:model-value="pick(String($event))"
        />
        <span v-if="action" class="field-hint" data-test="plugin-action-description">
            <code>{{ pluginKey }} / {{ actionKey }}</code> · {{ action.description }}
        </span>
        <span v-if="offline" class="field-warning" role="status" data-test="plugin-offline">
            {{ t('behaviors.action.plugin.offline') }}
        </span>
        <span v-if="undeclared" class="field-warning" role="status" data-test="plugin-action-undeclared">
            {{ t('behaviors.action.plugin.undeclared') }}
        </span>
        <p v-if="error" class="field-error">{{ error }}</p>
    </label>
</template>

<style scoped>
.field { display: flex; flex-direction: column; gap: 0.25rem; min-width: 0; }
.field-label { font-size: 0.75rem; color: var(--text-muted); font-weight: 600; }
.field-hint { font-size: 0.75rem; color: var(--text-muted); overflow-wrap: anywhere; }
.field-warning { font-size: 0.75rem; color: var(--warn-text, var(--text)); }
.field-error { margin: 0; font-size: 0.75rem; color: var(--danger); }
</style>

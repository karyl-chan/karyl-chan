<script setup lang="ts">
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { Icon } from '@iconify/vue';
import { AppBadge, AppButton, Cluster, Spacer, Stack } from '@karyl-chan/ui';
import { getBehaviorDeliveries, type BehaviorDelivery } from '../../../api/behavior';
import { useRelativeTime } from '../../../composables/use-relative-time';
import { describeBehaviorError } from './behavior-errors';

/**
 * A behavior's recent webhook deliveries (#120): GET
 * /api/behaviors/:id/deliveries, loaded each time the list is opened, not
 * before. One row per delivery: when, ok or failed, the HTTP status, the
 * latency, the error code and its message, and the verified signature.
 */
const props = defineProps<{ behaviorId: number }>();

const { t } = useI18n();
const { relativeTime } = useRelativeTime();

const open = ref(false);
const loading = ref(false);
const error = ref<string | null>(null);
const deliveries = ref<BehaviorDelivery[] | null>(null);

async function load(): Promise<void> {
    loading.value = true;
    error.value = null;
    try {
        deliveries.value = (await getBehaviorDeliveries(props.behaviorId)).deliveries;
    } catch (err) {
        error.value = describeBehaviorError(t, err);
    } finally {
        loading.value = false;
    }
}

async function toggle(): Promise<void> {
    open.value = !open.value;
    if (open.value) await load();
}

function absolute(iso: string): string {
    return new Date(iso).toLocaleString();
}
</script>

<template>
    <section class="deliveries">
        <Stack gap="2">
            <Cluster gap="2">
                <button
                    type="button"
                    class="toggle"
                    data-test="deliveries-toggle"
                    :aria-expanded="open ? 'true' : 'false'"
                    @click="toggle"
                >
                    <Icon :icon="open ? 'material-symbols:expand-less-rounded' : 'material-symbols:expand-more-rounded'" width="16" height="16" aria-hidden="true" />
                    {{ t('behaviors.deliveries.title') }}
                </button>
                <Spacer />
                <AppButton v-if="open" size="sm" variant="ghost" :loading="loading" data-test="deliveries-refresh" @click="load">
                    {{ t('behaviors.deliveries.refresh') }}
                </AppButton>
            </Cluster>

            <template v-if="open">
                <p v-if="error" class="error" role="alert">{{ error }}</p>
                <p v-else-if="loading && !deliveries" class="muted">{{ t('behaviors.deliveries.loading') }}</p>
                <p v-else-if="deliveries && deliveries.length === 0" class="muted" data-test="deliveries-empty">{{ t('behaviors.deliveries.empty') }}</p>
                <ol v-else-if="deliveries" class="rows">
                    <li v-for="d in deliveries" :key="d.id" :class="['row', { failed: !d.ok }]" data-test="delivery-row">
                        <Stack gap="1">
                            <Cluster gap="2">
                                <time :datetime="d.firedAt" :title="absolute(d.firedAt)" class="muted">{{ relativeTime(d.firedAt) }}</time>
                                <AppBadge size="sm" :tone="d.ok ? 'success' : 'danger'">
                                    {{ d.ok ? t('behaviors.deliveries.ok') : t('behaviors.deliveries.failed') }}
                                </AppBadge>
                                <code v-if="d.httpStatus !== null" data-test="delivery-status">HTTP {{ d.httpStatus }}</code>
                                <span v-if="d.durationMs !== null" class="muted" data-test="delivery-duration">{{ d.durationMs }} ms</span>
                                <code v-if="d.errorCode">{{ d.errorCode }}</code>
                                <span v-if="d.verified" class="muted">{{ t(`behaviors.deliveries.verified.${d.verified}`) }}</span>
                            </Cluster>
                            <span v-if="d.error" class="detail">{{ d.error }}</span>
                        </Stack>
                    </li>
                </ol>
                <p class="muted note">{{ t('behaviors.deliveries.retention') }}</p>
            </template>
        </Stack>
    </section>
</template>

<style scoped>
.deliveries {
    font-size: 0.85rem;
}
.toggle {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    padding: 0;
    border: none;
    background: none;
    color: var(--text-strong);
    font: inherit;
    font-weight: 600;
    cursor: pointer;
}
.rows {
    list-style: none;
    margin: 0;
    padding: 0;
    max-height: 18rem;
    overflow: auto;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
}
.row {
    padding: 0.4rem 0.6rem;
    border-bottom: 1px solid var(--border);
}
.row:last-child { border-bottom: none; }
.detail {
    color: var(--danger);
    overflow-wrap: anywhere;
}
.muted { margin: 0; color: var(--text-muted); }
.note { font-size: 0.78rem; }
.error { margin: 0; color: var(--danger); }
</style>

<script setup lang="ts">
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { testBehavior, type TestFireResult } from '../../../api/behavior';
import { describeBehaviorError } from './behavior-errors';

/**
 * Test-firing a behavior's webhook (POST /api/behaviors/:id/test) and its
 * outcome — the reply on success, the error and its code otherwise. The
 * card's menu starts it with `run()`; it uses the saved settings.
 */
const props = defineProps<{ behaviorId: number }>();

const { t } = useI18n();
const testing = ref(false);
const result = ref<TestFireResult | null>(null);

async function run(): Promise<void> {
    testing.value = true;
    result.value = null;
    try {
        result.value = await testBehavior(props.behaviorId);
    } catch (err) {
        result.value = {
            ok: false,
            relayContent: '',
            relayEmbeds: [],
            error: describeBehaviorError(t, err),
            errorCode: null,
        };
    } finally {
        testing.value = false;
    }
}

defineExpose({ run });
</script>

<template>
    <div
        v-if="testing || result"
        :class="['test-result', { ok: result?.ok, failed: result && !result.ok }]"
        role="status"
        data-test="test-result"
    >
        <template v-if="testing">{{ t('behaviors.card.testing') }}</template>
        <template v-else-if="result?.ok">
            {{ t('behaviors.card.testOk') }}
            <code v-if="result.relayContent" class="relay">{{ result.relayContent }}</code>
        </template>
        <template v-else-if="result">
            {{ t('behaviors.card.testFailed', { error: result.error ?? '' }) }}
            <code v-if="result.errorCode">{{ result.errorCode }}</code>
        </template>
        <span class="note">{{ t('behaviors.card.testSavedOnly') }}</span>
    </div>
</template>

<style scoped>
.test-result {
    /* a failed webhook may answer with a whole error page */
    max-height: 8rem;
    overflow: auto;
    overflow-wrap: anywhere;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.4rem;
    padding: 0.5rem 0.7rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    font-size: 0.85rem;
}
.test-result.ok { border-color: var(--success-text, var(--border)); }
.test-result.failed { border-color: var(--danger); color: var(--danger); }
.note { flex-basis: 100%; font-size: 0.75rem; color: var(--text-muted); }
.relay { overflow-wrap: anywhere; }
</style>

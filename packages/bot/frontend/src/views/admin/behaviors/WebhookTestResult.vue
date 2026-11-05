<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { testBehavior, type ReplyNoteView, type ReplyVisibility, type TestFireResult } from '../../../api/behavior';
import { describeBehaviorError } from './behavior-errors';
import { replyPreview, type ReplyTargetKind } from './reply-preview';

/**
 * Test-firing a behavior's webhook (POST /api/behaviors/:id/test) and its
 * outcome. On success, the reply as the bot would render it (#140): its
 * content, embeds, link buttons, who would see it and what the phase-1
 * rules changed. Otherwise the error, its code, and a hint when the
 * service refused the test signature (#101). The card's menu starts it
 * with `run()`; it uses the saved settings.
 */
const props = defineProps<{
    behaviorId: number;
    target: ReplyTargetKind;
    /** The saved behavior's reply default, applied when the response does not say. */
    visibility?: ReplyVisibility | null;
}>();

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
            reply: {},
            notes: [],
            status: null,
            error: describeBehaviorError(t, err),
            errorCode: null,
            verified: null,
        };
    } finally {
        testing.value = false;
    }
}

defineExpose({ run });

const preview = computed(() =>
    result.value?.ok ? replyPreview(result.value.reply, props.target, props.visibility ?? null) : null
);

function noteText(note: ReplyNoteView): string {
    switch (note.kind) {
        case 'content_truncated':
            return t('behaviors.testReply.note.content_truncated', { length: note.length });
        case 'embeds_dropped':
            return t('behaviors.testReply.note.embeds_dropped', { count: note.count });
        case 'components_dropped':
            return t('behaviors.testReply.note.components_dropped', { count: note.count });
        case 'unknown_fields':
            return t('behaviors.testReply.note.unknown_fields', { fields: note.fields.join(', ') });
        case 'invalid_field':
            return t('behaviors.testReply.note.invalid_field', { field: note.field });
        case 'flags_dropped':
            return t('behaviors.testReply.note.flags_dropped', { flags: note.flags });
    }
}

/** Why a failure may be what a correctly built receiver does with a test. */
const failureHint = computed(() => {
    const r = result.value;
    if (!r || r.ok) return null;
    if (r.status === 401 || r.status === 403) return t('behaviors.testReply.refusedHint');
    if (r.errorCode === 'response_signature') return t('behaviors.testReply.signatureHint');
    return null;
});
</script>

<template>
    <div
        v-if="testing || result"
        :class="['test-result', { ok: result?.ok, failed: result && !result.ok }]"
        role="status"
        data-test="test-result"
    >
        <template v-if="testing">{{ t('behaviors.card.testing') }}</template>
        <template v-else-if="result?.ok && preview">
            <span>{{ t('behaviors.card.testOk') }}</span>
            <div class="preview" data-test="reply-preview">
                <span v-if="preview.empty" class="muted">{{ t('behaviors.testReply.empty') }}</span>
                <template v-else>
                    <code v-if="preview.content" class="relay">{{ preview.content }}</code>
                    <span v-if="preview.embedTitles.length" data-test="preview-embeds">
                        {{
                            t('behaviors.testReply.embeds', {
                                count: preview.embedTitles.length,
                                titles: preview.embedTitles.map((x) => x ?? t('behaviors.testReply.untitled')).join(', '),
                            })
                        }}
                    </span>
                    <span v-for="(b, i) in preview.buttons" :key="i" data-test="preview-button">
                        {{ t('behaviors.testReply.button', { label: b.label, url: b.url }) }}
                    </span>
                    <span class="audience" data-test="preview-audience">
                        {{ t(`behaviors.testReply.audience.${preview.audience}`) }}
                    </span>
                </template>
                <span v-if="result.verified" class="verified" data-test="preview-verified">
                    {{ t(`behaviors.testReply.verified.${result.verified}`) }}
                </span>
                <ul v-if="result.notes.length" class="notes" data-test="preview-notes">
                    <li v-for="(n, i) in result.notes" :key="i">{{ noteText(n) }}</li>
                </ul>
            </div>
        </template>
        <template v-else-if="result">
            {{ t('behaviors.card.testFailed', { error: result.error ?? '' }) }}
            <code v-if="result.errorCode">{{ result.errorCode }}</code>
            <code v-else-if="result.status">{{ t('behaviors.testReply.status', { status: result.status }) }}</code>
            <span v-if="failureHint" class="hint" data-test="test-hint">{{ failureHint }}</span>
        </template>
        <span class="note">{{ t('behaviors.card.testSavedOnly') }} {{ t('behaviors.testReply.signedAsTest') }}</span>
    </div>
</template>

<style scoped>
.test-result {
    /* a failed webhook may answer with a whole error page */
    max-height: 14rem;
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
.preview { flex-basis: 100%; display: flex; flex-direction: column; gap: 0.25rem; }
.audience { font-size: 0.8rem; color: var(--text-muted); }
.verified { font-size: 0.8rem; color: var(--success-text, var(--text-muted)); }
.muted { color: var(--text-muted); }
.notes { margin: 0; padding-left: 1.1rem; font-size: 0.78rem; color: var(--text-muted); }
.hint { flex-basis: 100%; font-size: 0.8rem; color: var(--text); }
.note { flex-basis: 100%; font-size: 0.75rem; color: var(--text-muted); }
.relay { overflow-wrap: anywhere; white-space: pre-wrap; }
</style>

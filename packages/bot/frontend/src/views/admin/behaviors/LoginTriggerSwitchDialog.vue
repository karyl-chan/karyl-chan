<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { AppButton, AppModal, Stack } from '@karyl-chan/ui';
import {
    getBehaviorSchemas,
    switchLoginTrigger,
    type BehaviorItemView,
    type RegistrationReport,
} from '../../../api/behavior';
import CommandRegistrationResult from './CommandRegistrationResult.vue';
import LoginTriggerFields from './LoginTriggerFields.vue';
import { NO_ERRORS, errorsFromRefusal, isStale, type FormErrors } from './behavior-errors';
import {
    loginDraftSection,
    loginTriggerDraftErrors,
    loginTriggerDraftOf,
    loginTriggerFields,
    loginTriggerPatch,
    loginTriggerText,
    switchDraftOf,
    type LoginTriggerDraft,
} from './login-trigger-draft';
import {
    isRegistrationRefusal,
    registrationFailure,
    registrationResult,
    type RegistrationResult,
} from './registration-result';
import { sectionLabel } from './section-labels';

/**
 * Board 4: switching the login between a message pattern and a command,
 * opened from the card's kind tag (#172). First the new trigger's fields
 * (LoginTriggerFields, the card's own editor), checked as the admin types.
 * The login is the only way into the admin UI, so the dialog then says the
 * order before anything happens — the new trigger takes effect first, the
 * old one goes only after — and afterwards what each step did, with
 * Discord's own answer (CommandRegistrationResult). A refusal leaves the
 * login as it was, and the dialog says so; a refused field sends the admin
 * back to it.
 */
const props = defineProps<{
    visible: boolean;
    saved: BehaviorItemView;
    guildNames: ReadonlyMap<string, string>;
}>();

const emit = defineEmits<{
    (e: 'close'): void;
    /** The switch went through: the login as it now is. */
    (e: 'switched', result: { system: BehaviorItemView; registration: RegistrationReport | null }): void;
    /** Refused as stale (the login changed since the page loaded): the card reloads it. */
    (e: 'refused', err: unknown): void;
}>();

const { t } = useI18n();

type Phase = 'fill' | 'confirm' | 'running' | 'done' | 'failed';
const phase = ref<Phase>('fill');
const report = ref<RegistrationReport | null>(null);
const outcome = ref<RegistrationResult | null>(null);

/** The trigger the login had when the dialog opened (`saved` follows the switch once it is done). */
const before = ref('');
const beforeKind = ref<'message' | 'command'>('message');

/** The new trigger: the other kind than the saved one, filled in here. */
const otherKind = () => (props.saved.kind === 'message' ? 'command' : 'message');
const draft = ref<LoginTriggerDraft>(switchDraftOf(props.saved, otherKind()));
const errors = ref<FormErrors>(NO_ERRORS);
const schema = ref<Record<string, unknown> | null>(null);

watch(
    () => props.visible,
    (visible) => {
        if (!visible) return;
        phase.value = 'fill';
        report.value = null;
        outcome.value = null;
        errors.value = NO_ERRORS;
        before.value = loginTriggerText(loginTriggerDraftOf(props.saved));
        beforeKind.value = props.saved.kind;
        draft.value = switchDraftOf(props.saved, otherKind());
        getBehaviorSchemas()
            .then((schemas) => (schema.value = schemas.loginTrigger ?? null))
            .catch(() => undefined);
    },
    { immediate: true }
);

function patchDraft(patch: Partial<LoginTriggerDraft>) {
    draft.value = { ...draft.value, ...patch };
    errors.value = NO_ERRORS;
}

/** What the server would refuse in the new trigger, while the admin types (login-trigger-draft.ts). */
const liveErrors = computed(() => loginTriggerDraftErrors(t, draft.value, schema.value).fields);
const fieldErrors = computed(() => ({ ...errors.value.fields, ...liveErrors.value }));
const canGoOn = computed(() => Object.keys(fieldErrors.value).length === 0);

const after = computed(() => loginTriggerText(draft.value));
const toCommand = computed(() => draft.value.kind === 'command');
const landsIn = computed(() => sectionLabel(t, loginDraftSection(draft.value), props.guildNames));

function where(kind: 'message' | 'command'): string {
    return kind === 'message'
        ? t('behaviors.system.whereMessage')
        : t('behaviors.system.whereCommand', { section: landsIn.value });
}

interface Step {
    text: string;
    sub: string;
    mark: string;
    tone: 'todo' | 'ok' | 'warn' | 'fail' | 'skip';
}

const steps = computed<Step[]>(() => {
    const base = toCommand.value
        ? [
              { text: t('behaviors.system.steps.register', { command: after.value }), sub: t('behaviors.system.steps.registerSub') },
              { text: t('behaviors.system.steps.confirm'), sub: t('behaviors.system.steps.confirmSub') },
              { text: t('behaviors.system.steps.disable', { old: before.value }), sub: t('behaviors.system.steps.disableSub') },
          ]
        : [
              { text: t('behaviors.system.steps.enable', { pattern: after.value }), sub: t('behaviors.system.steps.enableSub') },
              { text: t('behaviors.system.steps.remove', { command: before.value }), sub: t('behaviors.system.steps.removeSub') },
          ];
    return base.map((step, i): Step => {
        if (phase.value === 'confirm' || phase.value === 'running') {
            return { ...step, mark: String(i + 1), tone: 'todo' };
        }
        if (phase.value === 'failed') {
            return i === 0
                ? { ...step, sub: outcome.value?.headline ?? step.sub, mark: '✕', tone: 'fail' }
                : { ...step, sub: t('behaviors.system.steps.notRun'), mark: '–', tone: 'skip' };
        }
        // done: leaving a command, Discord may not have let it go yet
        const last = i === base.length - 1;
        if (!toCommand.value && last && report.value?.status === 'deferred') {
            return { ...step, sub: report.value.reason, mark: '!', tone: 'warn' };
        }
        return { ...step, mark: '✓', tone: 'ok' };
    });
});

function next() {
    if (canGoOn.value) phase.value = 'confirm';
}

async function start() {
    const patch = loginTriggerPatch(props.saved, draft.value);
    if (!patch || phase.value !== 'confirm') return;
    phase.value = 'running';
    try {
        const result = await switchLoginTrigger(patch);
        report.value = result.registration;
        outcome.value = result.registration ? registrationResult(t, result.registration, props.guildNames) : null;
        phase.value = 'done';
        emit('switched', result);
    } catch (err) {
        if (isStale(err)) {
            phase.value = 'fill';
            emit('refused', err);
            return;
        }
        if (!isRegistrationRefusal(err)) {
            // a field the server refused (a name taken, a pattern): back to it
            errors.value = errorsFromRefusal(t, err, loginTriggerFields(draft.value));
            phase.value = 'fill';
            return;
        }
        outcome.value = registrationFailure(t, err, props.guildNames);
        phase.value = 'failed';
    }
}

const ended = computed(() => phase.value === 'done' || phase.value === 'failed');
</script>

<template>
    <AppModal
        :visible="visible"
        :title="t('behaviors.system.switch.title')"
        :close-label="t('common.close')"
        width="min(560px, 95vw)"
        @close="emit('close')"
    >
        <Stack v-if="phase === 'fill'" gap="4" data-test="switch-dialog">
            <p class="intro">
                {{ t(toCommand ? 'behaviors.system.switch.fillCommand' : 'behaviors.system.switch.fillMessage', { old: before }) }}
            </p>
            <form data-test="switch-fill" @submit.prevent="next">
                <Stack gap="3">
                    <LoginTriggerFields
                        :draft="draft"
                        :errors="fieldErrors"
                        :section="saved.section"
                        :guild-names="guildNames"
                        @patch="patchDraft"
                    />
                    <p v-if="errors.general" class="failed" role="alert" data-test="switch-general-error">{{ errors.general }}</p>
                    <footer class="footer">
                        <AppButton variant="secondary" @click="emit('close')">{{ t('common.cancel') }}</AppButton>
                        <AppButton type="submit" data-test="switch-next" :disabled="!canGoOn">
                            {{ t('behaviors.system.switch.next') }}
                        </AppButton>
                    </footer>
                </Stack>
            </form>
        </Stack>

        <Stack v-else gap="4" data-test="switch-dialog">
            <div class="compare">
                <div class="box">
                    <code class="trigger">{{ before }}</code>
                    <span class="muted">{{ where(beforeKind) }}</span>
                </div>
                <span class="arrow" aria-hidden="true">→</span>
                <div class="box next">
                    <code class="trigger">{{ after }}</code>
                    <span class="muted">{{ where(draft.kind) }}</span>
                </div>
            </div>

            <p class="intro">{{ t('behaviors.system.switch.intro', { old: before }) }}</p>
            <p v-if="!toCommand" class="intro" data-test="switch-sample">
                {{ t('behaviors.system.switch.sampleNote', { sample: draft.sample.trim(), pattern: after }) }}
            </p>
            <ol class="steps" data-test="switch-steps">
                <li v-for="(step, i) in steps" :key="i" :class="['step', step.tone]" :data-tone="step.tone">
                    <span class="mark" aria-hidden="true">{{ step.mark }}</span>
                    <span class="step-text">
                        <span>{{ step.text }}</span>
                        <span class="sub">{{ step.sub }}</span>
                    </span>
                </li>
            </ol>

            <p v-if="phase === 'failed'" class="failed" role="alert" data-test="switch-failed">
                {{ t('behaviors.system.switch.failed', { old: before }) }}
            </p>
            <p v-if="phase === 'done'" class="done" role="status" data-test="switch-done">
                {{ t('behaviors.system.switch.done', { trigger: after, section: landsIn }) }}
            </p>
            <CommandRegistrationResult v-if="outcome" :result="outcome" @dismiss="outcome = null" />

            <footer class="footer">
                <template v-if="!ended">
                    <AppButton variant="ghost" data-test="switch-back" :disabled="phase === 'running'" @click="phase = 'fill'">
                        {{ t('behaviors.system.switch.back') }}
                    </AppButton>
                    <AppButton variant="secondary" :disabled="phase === 'running'" @click="emit('close')">
                        {{ t('common.cancel') }}
                    </AppButton>
                    <AppButton data-test="switch-start" :loading="phase === 'running'" @click="start">
                        {{ t('behaviors.system.switch.start') }}
                    </AppButton>
                </template>
                <AppButton v-else data-test="switch-close" @click="emit('close')">{{ t('common.close') }}</AppButton>
            </footer>
        </Stack>
    </AppModal>
</template>

<style scoped>
.compare {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
    gap: 0.6rem;
    align-items: center;
}
.box {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    padding: 0.6rem 0.75rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg-page);
    min-width: 0;
}
.box.next { border-color: var(--accent); }
.trigger { color: var(--text-strong); overflow-wrap: anywhere; }
.arrow { color: var(--text-muted); }
.muted { color: var(--text-muted); font-size: 0.78rem; }
.intro { margin: 0; line-height: 1.7; font-size: 0.9rem; }
.steps { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 0.5rem; }
.step { display: flex; gap: 0.6rem; align-items: flex-start; }
.mark {
    flex: none;
    width: 1.4rem;
    height: 1.4rem;
    border-radius: 50%;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 0.75rem;
    background: var(--bg-page);
    border: 1px solid var(--border);
}
.step.ok .mark { background: var(--success, #248046); color: #fff; border-color: transparent; }
.step.fail .mark { background: var(--danger); color: #fff; border-color: transparent; }
.step.warn .mark { background: var(--warn, #b45309); color: #fff; border-color: transparent; }
.step.skip { color: var(--text-muted); }
.step-text { display: flex; flex-direction: column; gap: 0.1rem; font-size: 0.9rem; }
.sub { font-size: 0.78rem; color: var(--text-muted); }
.step.fail .sub { color: var(--danger); }
.failed, .done {
    margin: 0;
    padding: 0.6rem 0.75rem;
    border-radius: var(--radius-sm);
    line-height: 1.6;
    font-size: 0.88rem;
}
.failed { border: 1px solid var(--danger); color: var(--danger); }
.done { border: 1px solid var(--success, var(--border)); }
.footer { display: flex; justify-content: flex-end; gap: 0.5rem; }
</style>

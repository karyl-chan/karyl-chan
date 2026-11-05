import type { RegistrationReport, RegistrationTargetOutcome } from '../../../api/behavior';
import { ApiError } from '../../../api/client';
import { describeBehaviorError } from './behavior-errors';
import type { Translate } from './translate';

/**
 * What a command write did on Discord, in words: the registration report
 * of a write that went through, or the refusal of one that did not. A
 * refused registration (`registration_failed`) shows the error Discord
 * gave and each target's outcome — never success (#107).
 */
export interface RegistrationResult {
    tone: 'ok' | 'warn' | 'danger';
    headline: string;
    /** The server's own words: why registration waits, or Discord's error. */
    detail: string | null;
    /** One line per registration target (global or a guild). */
    targets: Array<{ target: string; text: string; detail?: string }>;
}

function targetLabel(t: Translate, target: string, guildNames: ReadonlyMap<string, string>): string {
    if (target === 'global') return t('behaviors.registration.target.global');
    const guildId = target.startsWith('guild:') ? target.slice('guild:'.length) : target;
    return guildNames.get(guildId) ?? guildId;
}

function outcomeLines(
    t: Translate,
    targets: readonly RegistrationTargetOutcome[],
    guildNames: ReadonlyMap<string, string>,
): RegistrationResult['targets'] {
    return targets.map((o) => ({
        target: targetLabel(t, o.target, guildNames),
        text: t(`behaviors.registration.outcome.${o.status}`),
        ...(o.status === 'failed' ? { detail: `${o.attempted}: ${o.error}` } : {}),
    }));
}

export function registrationResult(
    t: Translate,
    report: RegistrationReport,
    guildNames: ReadonlyMap<string, string>,
): RegistrationResult {
    switch (report.status) {
        case 'registered': {
            // a target that failed never gets here: the server answers registration_failed
            const tone = report.targets.some((o) => o.status === 'skipped') ? 'warn' : 'ok';
            return {
                tone,
                headline: t('behaviors.registration.registered'),
                detail: null,
                targets: outcomeLines(t, report.targets, guildNames),
            };
        }
        case 'deferred':
            return {
                tone: 'warn',
                headline: t('behaviors.registration.deferred'),
                detail: report.reason,
                targets: [],
            };
        case 'removed':
            return { tone: 'ok', headline: t('behaviors.registration.removed'), detail: null, targets: [] };
    }
}

function failedTargets(details: unknown): RegistrationTargetOutcome[] {
    const targets = (details as { targets?: unknown } | null)?.targets;
    return Array.isArray(targets)
        ? targets.filter(
              (o): o is RegistrationTargetOutcome =>
                  typeof o === 'object' && o !== null && typeof (o as { target?: unknown }).target === 'string'
          )
        : [];
}

/** Discord refused (or could not be reached for) a command write: nothing changed there. */
export function isRegistrationRefusal(err: unknown): err is ApiError {
    return err instanceof ApiError && err.code === 'registration_failed';
}

/** A command write that was refused: Discord's own error first, then each target. */
export function registrationFailure(
    t: Translate,
    err: unknown,
    guildNames: ReadonlyMap<string, string>,
): RegistrationResult {
    if (isRegistrationRefusal(err)) {
        return {
            tone: 'danger',
            headline: t('behaviors.registration.failed'),
            detail: err.message,
            targets: outcomeLines(t, failedTargets(err.details), guildNames),
        };
    }
    return { tone: 'danger', headline: describeBehaviorError(t, err), detail: null, targets: [] };
}

import { ApiError } from '../../../api/client';
import { SERVICE_AUDIENCE_PATTERN, type ServiceInput, type ServicePatch, type ServiceView } from '../../../api/services';
import type { Translate } from '../behaviors/translate';

/** A service form's errors, by field; `general` for what no field owns. */
export interface ServiceFormErrors {
    fields: Partial<Record<keyof ServiceInput, string>>;
    general: string | null;
}

export const NO_SERVICE_ERRORS: ServiceFormErrors = { fields: {}, general: null };

const FIELDS: ReadonlyArray<keyof ServiceInput> = ['name', 'audience', 'redirectUrl'];

export function emptyServiceDraft(): ServiceInput {
    return { name: '', audience: '', redirectUrl: '' };
}

export function draftOfService(service: ServiceView): ServiceInput {
    return { name: service.name, audience: service.audience, redirectUrl: service.redirectUrl };
}

/** The body the form sends (the name trimmed). */
export function serviceBody(draft: ServiceInput): ServiceInput {
    return { name: draft.name.trim(), audience: draft.audience.trim(), redirectUrl: draft.redirectUrl.trim() };
}

/** What the server would refuse, found before sending (it checks again). */
export function checkServiceDraft(t: Translate, draft: ServiceInput): ServiceFormErrors {
    const body = serviceBody(draft);
    const fields: ServiceFormErrors['fields'] = {};
    if (body.name === '') fields.name = t('services.error.nameRequired');
    if (!SERVICE_AUDIENCE_PATTERN.test(body.audience)) fields.audience = t('services.error.audience');
    let url: URL | null = null;
    try {
        url = new URL(body.redirectUrl);
    } catch {
        url = null;
    }
    if (!url || url.protocol !== 'https:') fields.redirectUrl = t('services.error.https');
    return { fields, general: null };
}

/** The PUT for an edit: the changed fields and the version it is based on; null when nothing changed. */
export function servicePatch(saved: ServiceView, draft: ServiceInput): ServicePatch | null {
    const body = serviceBody(draft);
    const patch: ServicePatch = {};
    for (const key of FIELDS) if (body[key] !== saved[key]) patch[key] = body[key];
    if (Object.keys(patch).length === 0) return null;
    return { ...patch, ifUpdatedAt: saved.updatedAt };
}

/** A server refusal → the field it names, else a general error. */
export function serviceErrorsFromRefusal(err: unknown): ServiceFormErrors {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof ApiError && err.field && (FIELDS as readonly string[]).includes(err.field)) {
        return { fields: { [err.field]: message }, general: null };
    }
    return { fields: {}, general: message };
}

export function hasServiceErrors(errors: ServiceFormErrors): boolean {
    return Object.keys(errors.fields).length > 0 || errors.general !== null;
}

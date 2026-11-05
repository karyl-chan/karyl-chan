import { ApiError } from '../../../api/client';
import { issueMessage, type SchemaIssues } from './form-schema';
import type { Translate } from './translate';

const KNOWN_CODES = new Set([
    'validation_failed',
    'name_conflict',
    'system_immutable',
    'registration_failed',
    'not_found',
    'invalid_tree',
]);

/** A refusal in words: the code's meaning in the UI language, then the server's detail. */
export function describeBehaviorError(t: Translate, err: unknown): string {
    if (err instanceof ApiError && err.code && KNOWN_CODES.has(err.code)) {
        return t('behaviors.errors.withDetail', {
            reason: t(`behaviors.errors.${err.code}`),
            detail: err.message,
        });
    }
    return err instanceof Error ? err.message : String(err);
}

/** A refusal for an edit based on an outdated version (#121). */
export function isStale(err: unknown): boolean {
    return err instanceof ApiError && err.status === 409 && err.code === 'validation_failed';
}

export interface FormErrors {
    /** Messages by request field path, shown on that field. */
    fields: Record<string, string>;
    /** A message no field of the form owns. */
    general: string | null;
}

export const NO_ERRORS: FormErrors = { fields: {}, general: null };

export function hasErrors(errors: FormErrors): boolean {
    return Object.keys(errors.fields).length > 0 || errors.general !== null;
}

/** Schema issues → errors on the form's fields (anything else is general). */
export function errorsFromIssues(t: Translate, issues: SchemaIssues, fields: readonly string[]): FormErrors {
    const out: FormErrors = { fields: {}, general: null };
    for (const [path, issue] of Object.entries(issues)) {
        if (fields.includes(path)) out.fields[path] = issueMessage(t, issue);
        else out.general ??= `${path}: ${issueMessage(t, issue)}`;
    }
    return out;
}

/**
 * A server refusal → the field it names when the form has it, else a
 * general error. `formField` maps the request path to the form's own
 * (a dialog that sends `leaves.0.title` shows it on `title`).
 */
export function errorsFromRefusal(
    t: Translate,
    err: unknown,
    fields: readonly string[],
    formField: (requestField: string) => string = (f) => f,
): FormErrors {
    const field = err instanceof ApiError && err.field ? formField(err.field) : null;
    if (field && fields.includes(field)) {
        return { fields: { [field]: (err as ApiError).message }, general: null };
    }
    return { fields: {}, general: describeBehaviorError(t, err) };
}

/** Keep only the errors on `fields`; the first of the rest becomes the general error. */
export function onFields(errors: FormErrors, fields: readonly string[]): FormErrors {
    const out: FormErrors = { fields: {}, general: errors.general };
    for (const [field, message] of Object.entries(errors.fields)) {
        if (fields.includes(field)) out.fields[field] = message;
        else out.general ??= `${field}: ${message}`;
    }
    return out;
}

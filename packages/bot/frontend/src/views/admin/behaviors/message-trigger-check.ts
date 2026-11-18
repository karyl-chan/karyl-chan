import { getBehaviorSchemas } from '../../../api/behavior';
import { errorsFromIssues, type FormErrors } from './behavior-errors';
import { checkAgainstSchema, type SchemaIssues } from './form-schema';
import { previewMatch, toCreateBody, type MessageTriggerBody, type MessageTriggerDraft } from './message-trigger-draft';
import { ACTION_ERROR_FIELDS } from './webhook-draft';
import type { Translate } from './translate';

/**
 * Which parts of a message trigger form are on screen — the card shows
 * everything; the new-behavior and conversion dialogs have no description
 * field.
 */
export interface TriggerFormLayout {
    description: boolean;
}

/**
 * The request fields the form's target select stands for: where the
 * trigger is and for whom (ADR 0004). A problem with any of them shows on
 * that one field.
 */
const TARGET_REQUEST_FIELDS: readonly string[] = [
    'surface',
    'guildId',
    'channelId',
    'audienceKind',
    'audienceUserId',
    'audienceGroupName',
    // a trigger conversion sends the location as one key
    'location',
];

/** The form field a request field's error shows on. */
export function triggerFormField(requestField: string): string {
    return TARGET_REQUEST_FIELDS.includes(requestField) ? 'target' : requestField;
}

/** A form field a message trigger form can show an error on. */
export type FormField =
    | 'target'
    | Exclude<keyof MessageTriggerBody, 'webhook' | 'pluginAction'>
    | (typeof ACTION_ERROR_FIELDS)[number];

/**
 * The fields that have an error line on screen right now. An error for any
 * other field (a checkbox) must not be put on a field nobody sees: the
 * form shows it as a general error instead.
 */
export function fieldsWithErrorLine(layout: TriggerFormLayout): FormField[] {
    const fields: FormField[] = ['title', 'target', 'patternValue', ...ACTION_ERROR_FIELDS];
    if (layout.description) fields.push('description');
    return fields;
}

/** Schema issues by request field → by the form field each shows on (the first one wins). */
export function issuesByFormField(issues: SchemaIssues): SchemaIssues {
    const out: SchemaIssues = {};
    for (const [path, issue] of Object.entries(issues)) out[triggerFormField(path)] ??= issue;
    return out;
}

/**
 * What the server would refuse in a message trigger draft, found before
 * sending it: the request body against the server's own schema (#108),
 * plus a regex that does not compile (the try-it box already knows). When
 * the schema cannot be loaded the server stays the only check.
 */
export async function checkMessageTriggerDraft(
    t: Translate,
    draft: MessageTriggerDraft,
    layout: TriggerFormLayout,
): Promise<FormErrors> {
    const body = toCreateBody(draft);
    const schemas = await getBehaviorSchemas().catch(() => null);
    const found: FormErrors = schemas
        ? errorsFromIssues(
              t,
              issuesByFormField(checkAgainstSchema(schemas.messageTrigger, body)),
              fieldsWithErrorLine(layout),
          )
        : { fields: {}, general: null };
    if (body.patternKind === 'regex' && previewMatch('regex', body.patternValue, '') === 'invalid') {
        found.fields.patternValue ??= t('behaviors.trigger.preview.invalid');
    }
    return found;
}

import { getBehaviorSchemas } from '../../../api/behavior';
import { errorsFromIssues, type FormErrors } from './behavior-errors';
import { checkAgainstSchema } from './form-schema';
import { previewMatch, toCreateBody, type MessageTriggerBody, type MessageTriggerDraft } from './message-trigger-draft';
import { kindHasGuild, type LocationKind } from './message-trigger-location';
import type { Translate } from './translate';

/**
 * Which parts of a message trigger form are on screen — the card shows
 * everything; the new-behavior dialog fixes what its section fixes and has
 * no description field.
 */
export interface TriggerFormLayout {
    /** The kinds of location the form may pick; one = fixed, no picker. */
    kinds: readonly LocationKind[];
    lockGuild: boolean;
    lockChannel: boolean;
    description: boolean;
}

/** A request field a form can show an error on (the server's `error.field` paths). */
export type FormField = Exclude<keyof MessageTriggerBody, 'webhook'> | 'webhook.url' | 'webhook.authMode';

/**
 * The fields that have an error line on screen right now. An error for any
 * other field (a fixed location, a checkbox) must not be put on a field
 * nobody sees: the form shows it as a general error instead.
 */
export function fieldsWithErrorLine(draft: MessageTriggerDraft, layout: TriggerFormLayout): FormField[] {
    const fields: FormField[] = ['title', 'patternValue', 'webhook.url', 'webhook.authMode'];
    if (layout.description) fields.push('description');
    if (layout.kinds.length > 1) fields.push('surface');
    if (kindHasGuild(draft.locationKind) && !layout.lockGuild) fields.push('guildId');
    if (draft.locationKind === 'channel' && !layout.lockChannel) fields.push('channelId');
    if (draft.locationKind === 'bot_dm') {
        fields.push('audienceKind');
        if (draft.audienceKind === 'user') fields.push('audienceUserId');
        if (draft.audienceKind === 'group') fields.push('audienceGroupName');
    }
    return fields;
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
        ? errorsFromIssues(t, checkAgainstSchema(schemas.messageTrigger, body), fieldsWithErrorLine(draft, layout))
        : { fields: {}, general: null };
    if (body.patternKind === 'regex' && previewMatch('regex', body.patternValue, '') === 'invalid') {
        found.fields.patternValue ??= t('behaviors.trigger.preview.invalid');
    }
    return found;
}

export function hasErrors(errors: FormErrors): boolean {
    return Object.keys(errors.fields).length > 0 || errors.general !== null;
}

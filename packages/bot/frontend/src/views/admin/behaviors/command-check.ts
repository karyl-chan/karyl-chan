import { getBehaviorSchemas } from '../../../api/behavior';
import { errorsFromIssues, type FormErrors } from './behavior-errors';
import { commandBody, visibilityOf, type CommandDraft } from './command-draft';
import { RESERVED_COMMAND_NAMES, visibilityIssues } from './command-rules';
import { checkAgainstSchema, type JsonSchema } from './form-schema';
import type { Translate } from './translate';

/** The command fields a form shows an error line on (the server's `error.field` paths). */
export type CommandFormField =
    | 'name'
    | 'description'
    | 'registration'
    | 'guildId'
    | 'integrationTypes'
    | 'contexts'
    | 'defaultMemberPermissions';

export function commandFieldsWithErrorLine(draft: CommandDraft): CommandFormField[] {
    const fields: CommandFormField[] = ['name', 'description', 'registration', 'defaultMemberPermissions'];
    if (draft.registration === 'guild') fields.push('guildId');
    else fields.push('integrationTypes', 'contexts');
    return fields;
}

/** The command schema without its leaves: a command's own fields. */
export function commandFieldsSchema(command: JsonSchema): JsonSchema {
    const { leaves: _leaves, ...properties } = (command.properties ?? {}) as Record<string, unknown>;
    return {
        ...command,
        properties,
        required: ((command.required as string[] | undefined) ?? []).filter((k) => k !== 'leaves'),
    };
}

/**
 * What the server would refuse in a command draft: the body against the
 * server's own command schema (#108; null = not loaded, the server then
 * checks the formats alone), Discord's visibility rules (command-rules.ts,
 * the pinned mirror of the server's) and the reserved names. Synchronous,
 * so the card can show it while the admin types (board 5).
 */
export function commandDraftErrors(t: Translate, draft: CommandDraft, commandSchema: JsonSchema | null): FormErrors {
    const body = commandBody(draft);
    const found: FormErrors = commandSchema
        ? errorsFromIssues(t, checkAgainstSchema(commandFieldsSchema(commandSchema), body), commandFieldsWithErrorLine(draft))
        : { fields: {}, general: null };
    for (const issue of visibilityIssues(visibilityOf(draft))) {
        found.fields[issue.field] ??= t(`behaviors.command.rule.${issue.rule}`);
    }
    if (RESERVED_COMMAND_NAMES.includes(body.name)) found.fields.name ??= t('behaviors.command.reservedName');
    return found;
}

/** commandDraftErrors against the served schema, fetched (once) first. */
export async function checkCommandDraft(t: Translate, draft: CommandDraft): Promise<FormErrors> {
    const schemas = await getBehaviorSchemas().catch(() => null);
    return commandDraftErrors(t, draft, schemas?.command ?? null);
}

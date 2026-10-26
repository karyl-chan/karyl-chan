import { getBehaviorSchemas } from '../../../api/behavior';
import { errorsFromIssues, type FormErrors } from './behavior-errors';
import { optionIssues } from './command-rules';
import { checkAgainstSchema, type JsonSchema } from './form-schema';
import { leafBody, type LeafDraft } from './leaf-draft';
import type { Translate } from './translate';

/**
 * Which leaf form: the root leaf (the command itself), a saved subcommand,
 * or a subcommand being added (its name is required there).
 */
export type LeafFormKind = 'root' | 'subcommand' | 'add';

/** The leaf fields with an error line on screen (the server's `error.field` paths, unprefixed). */
export function leafFieldsWithErrorLine(draft: LeafDraft, kind: LeafFormKind): string[] {
    const fields = ['title', 'description', 'options', 'webhook.url', 'webhook.authMode'];
    if (kind !== 'root') fields.push('subcommand', 'leafDescription');
    draft.options.forEach((_, i) => {
        for (const f of ['type', 'name', 'description', 'required']) fields.push(`options.${i}.${f}`);
    });
    return fields;
}

/** The schema a leaf body is checked against: an added subcommand's, or a command's leaf item. */
function leafSchema(schemas: { command?: JsonSchema; commandLeaf?: JsonSchema }, kind: LeafFormKind): JsonSchema | null {
    if (kind === 'add') return schemas.commandLeaf ?? null;
    const leaves = (schemas.command?.properties as Record<string, JsonSchema> | undefined)?.leaves;
    return (leaves?.items as JsonSchema | undefined) ?? null;
}

/**
 * What the server would refuse in a leaf draft, found before sending it:
 * the body against the server's own schema (#108) and the option rules
 * (command-rules.ts, the pinned mirror of the server's). Without the
 * schema the field formats are the server's to check.
 */
export async function checkLeafDraft(t: Translate, draft: LeafDraft, kind: LeafFormKind): Promise<FormErrors> {
    const body = leafBody(draft);
    const schemas = await getBehaviorSchemas().catch(() => null);
    const schema = schemas ? leafSchema(schemas, kind) : null;
    const found: FormErrors = schema
        ? errorsFromIssues(t, checkAgainstSchema(schema, body), leafFieldsWithErrorLine(draft, kind))
        : { fields: {}, general: null };
    for (const issue of optionIssues(body.options)) {
        const field = issue.index === null ? 'options' : `options.${issue.index}.${issue.field}`;
        found.fields[field] ??= t(`behaviors.command.optionRule.${issue.rule}`);
    }
    return found;
}

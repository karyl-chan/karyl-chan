/**
 * Checks a behavior form's request body against the JSON schema the bot
 * validates that request with (GET /api/behaviors/schema, #108), so the
 * form refuses what the server would refuse — without keeping a copy of
 * the rules here.
 *
 * Only the keywords the behavior schemas use are understood; anything
 * else is ignored (the server stays the authority). Field paths are the
 * dotted request paths the server names in `error.field`
 * (`webhook.url`, `userIds.1`), so a client issue and a server refusal
 * land on the same form field.
 *
 * Why the schema comes over the API rather than from a shared package:
 * plugin-wire is the bot↔plugin contract and keeps admin API shapes out
 * (its CONTEXT.md); the bot's schema module pulls in ajv, Fastify and the
 * models, so the SPA cannot import it; and a new workspace package would
 * add a build step and Docker stages for one object the route already
 * holds. Served, the rules the form checks are the rules the route runs.
 */

import type { Translate } from './translate';

export type JsonSchema = { readonly [key: string]: unknown };

export type SchemaKeyword =
    | 'required'
    | 'type'
    | 'enum'
    | 'const'
    | 'minLength'
    | 'maxLength'
    | 'pattern'
    | 'minItems'
    | 'maxItems'
    | 'uniqueItems'
    | 'minimum';

export interface SchemaIssue {
    keyword: SchemaKeyword;
    /** The bound a length / count / minimum keyword names. */
    limit?: number;
}

/** First issue per field path; empty when the value passes. */
export type SchemaIssues = Record<string, SchemaIssue>;

function typeMatches(type: unknown, value: unknown): boolean {
    const types = Array.isArray(type) ? type : [type];
    return types.some((t) => {
        switch (t) {
            case 'string':
                return typeof value === 'string';
            case 'boolean':
                return typeof value === 'boolean';
            case 'number':
                return typeof value === 'number' && Number.isFinite(value);
            case 'integer':
                return Number.isInteger(value);
            case 'null':
                return value === null;
            case 'array':
                return Array.isArray(value);
            case 'object':
                return typeof value === 'object' && value !== null && !Array.isArray(value);
            default:
                return true;
        }
    });
}

function join(path: string, key: string | number): string {
    return path ? `${path}.${key}` : String(key);
}

function add(issues: SchemaIssues, path: string, issue: SchemaIssue): void {
    if (!(path in issues)) issues[path] = issue;
}

function check(schema: JsonSchema, value: unknown, path: string, issues: SchemaIssues): void {
    if (Array.isArray(schema.anyOf)) {
        const branches = schema.anyOf as JsonSchema[];
        const results = branches.map((branch) => {
            const found: SchemaIssues = {};
            check(branch, value, path, found);
            return found;
        });
        if (results.some((r) => Object.keys(r).length === 0)) return;
        // explain the branch the value's type belongs to (a malformed id,
        // not "must be null"), else the first one
        const sameType = results.findIndex((_, i) => {
            const t = branches[i].type;
            return t === undefined || typeMatches(t, value);
        });
        Object.entries(results[sameType >= 0 ? sameType : 0]).forEach(([p, i]) => add(issues, p, i));
        return;
    }
    if ('const' in schema && value !== schema.const) {
        add(issues, path, { keyword: 'const' });
        return;
    }
    if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
        add(issues, path, { keyword: 'enum' });
        return;
    }
    if (schema.type !== undefined && !typeMatches(schema.type, value)) {
        add(issues, path, { keyword: 'type' });
        return;
    }

    if (typeof value === 'string') {
        // JSON schema (and ajv) count characters, not UTF-16 code units
        const length = [...value].length;
        if (typeof schema.minLength === 'number' && length < schema.minLength) {
            add(issues, path, { keyword: 'minLength', limit: schema.minLength });
            return;
        }
        if (typeof schema.maxLength === 'number' && length > schema.maxLength) {
            add(issues, path, { keyword: 'maxLength', limit: schema.maxLength });
            return;
        }
        if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern, 'u').test(value)) {
            add(issues, path, { keyword: 'pattern' });
        }
        return;
    }

    if (typeof value === 'number') {
        if (typeof schema.minimum === 'number' && value < schema.minimum) {
            add(issues, path, { keyword: 'minimum', limit: schema.minimum });
        }
        return;
    }

    if (Array.isArray(value)) {
        if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
            add(issues, path, { keyword: 'minItems', limit: schema.minItems });
            return;
        }
        if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) {
            add(issues, path, { keyword: 'maxItems', limit: schema.maxItems });
            return;
        }
        if (schema.uniqueItems === true) {
            const seen = value.map((v) => JSON.stringify(v));
            if (new Set(seen).size !== seen.length) {
                add(issues, path, { keyword: 'uniqueItems' });
                return;
            }
        }
        if (schema.items && typeof schema.items === 'object') {
            value.forEach((item, i) => check(schema.items as JsonSchema, item, join(path, i), issues));
        }
        return;
    }

    if (typeof value === 'object' && value !== null) {
        const record = value as Record<string, unknown>;
        for (const key of (schema.required as string[] | undefined) ?? []) {
            if (record[key] === undefined) add(issues, join(path, key), { keyword: 'required' });
        }
        const properties = (schema.properties ?? {}) as Record<string, JsonSchema>;
        for (const [key, sub] of Object.entries(properties)) {
            if (record[key] !== undefined) check(sub, record[key], join(path, key), issues);
        }
    }
}

export function checkAgainstSchema(schema: JsonSchema, value: unknown): SchemaIssues {
    const issues: SchemaIssues = {};
    check(schema, value, '', issues);
    return issues;
}

/** A schema issue in words; the field's own hint says what a valid value looks like. */
export function issueMessage(t: Translate, issue: SchemaIssue): string {
    switch (issue.keyword) {
        case 'required':
            return t('behaviors.validation.required');
        case 'minLength':
            return issue.limit === 1
                ? t('behaviors.validation.required')
                : t('behaviors.validation.tooShort', { min: issue.limit });
        case 'maxLength':
            return t('behaviors.validation.tooLong', { max: issue.limit });
        case 'maxItems':
            return t('behaviors.validation.tooMany', { max: issue.limit });
        case 'minItems':
            return t('behaviors.validation.tooFew', { min: issue.limit });
        case 'pattern':
            return t('behaviors.validation.format');
        default:
            return t('behaviors.validation.invalid');
    }
}

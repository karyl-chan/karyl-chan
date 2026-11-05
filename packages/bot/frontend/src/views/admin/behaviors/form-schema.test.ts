import { describe, expect, it } from 'vitest';
import { checkAgainstSchema, issueMessage } from './form-schema';

// A hand-written schema in the shape GET /api/behaviors/schema serves.
const schema = {
    type: 'object',
    properties: {
        title: { type: 'string', minLength: 1, maxLength: 5, pattern: '\\S' },
        guildId: { anyOf: [{ type: 'string', pattern: '^\\d{17,20}$' }, { type: 'null' }] },
        patternKind: { enum: ['startswith', 'endswith', 'regex'] },
        userIds: { type: 'array', maxItems: 2, items: { type: 'string', pattern: '^\\d{17,20}$' } },
        webhook: {
            type: 'object',
            properties: {
                url: { type: 'string', minLength: 1 },
                authMode: { enum: ['token', 'hmac', null] },
            },
            required: ['url'],
        },
    },
    required: ['title', 'webhook'],
};

const valid = {
    title: 'hi',
    guildId: null,
    patternKind: 'regex',
    userIds: ['123456789012345678'],
    webhook: { url: 'https://x', authMode: null },
};

describe('checkAgainstSchema', () => {
    it('finds nothing wrong with a valid value', () => {
        expect(checkAgainstSchema(schema, valid)).toEqual({});
    });

    it('names a missing field by its path', () => {
        const { title: _omit, ...rest } = valid;
        expect(checkAgainstSchema(schema, rest)).toEqual({ title: { keyword: 'required' } });
        expect(checkAgainstSchema(schema, { ...valid, webhook: {} })).toEqual({
            'webhook.url': { keyword: 'required' },
        });
    });

    it('reports length limits in characters, not UTF-16 units', () => {
        expect(checkAgainstSchema(schema, { ...valid, title: '😀😀😀😀😀' })).toEqual({});
        expect(checkAgainstSchema(schema, { ...valid, title: 'abcdef' })).toEqual({
            title: { keyword: 'maxLength', limit: 5 },
        });
        expect(checkAgainstSchema(schema, { ...valid, webhook: { url: '' } })).toEqual({
            'webhook.url': { keyword: 'minLength', limit: 1 },
        });
    });

    it('checks patterns, including a blank title', () => {
        expect(checkAgainstSchema(schema, { ...valid, title: '   ' })).toEqual({
            title: { keyword: 'pattern' },
        });
    });

    it('accepts either branch of anyOf and explains the branch of the same type', () => {
        expect(checkAgainstSchema(schema, { ...valid, guildId: '123456789012345678' })).toEqual({});
        expect(checkAgainstSchema(schema, { ...valid, guildId: '12345' })).toEqual({
            guildId: { keyword: 'pattern' },
        });
    });

    it('checks enums (null included) and array items by index', () => {
        expect(checkAgainstSchema(schema, { ...valid, patternKind: 'contains' })).toEqual({
            patternKind: { keyword: 'enum' },
        });
        expect(checkAgainstSchema(schema, { ...valid, webhook: { url: '\S', authMode: 'basic' } })).toEqual({
            'webhook.authMode': { keyword: 'enum' },
        });
        expect(
            checkAgainstSchema(schema, { ...valid, userIds: ['123456789012345678', 'nope'] })
        ).toEqual({ 'userIds.1': { keyword: 'pattern' } });
        expect(
            checkAgainstSchema(schema, { ...valid, userIds: ['123456789012345678', '223456789012345678', '323456789012345678'] })
        ).toEqual({ userIds: { keyword: 'maxItems', limit: 2 } });
    });

    it('reports a wrong type', () => {
        expect(checkAgainstSchema(schema, { ...valid, title: 3 })).toEqual({ title: { keyword: 'type' } });
    });
});

describe('issueMessage', () => {
    const t = (key: string, named?: Record<string, unknown>) =>
        named ? `${key}:${JSON.stringify(named)}` : key;

    it('treats a minimum length of one as "required"', () => {
        expect(issueMessage(t, { keyword: 'minLength', limit: 1 })).toBe('behaviors.validation.required');
        expect(issueMessage(t, { keyword: 'required' })).toBe('behaviors.validation.required');
    });

    it('names the limit of a length or count', () => {
        expect(issueMessage(t, { keyword: 'maxLength', limit: 100 })).toBe('behaviors.validation.tooLong:{"max":100}');
        expect(issueMessage(t, { keyword: 'maxItems', limit: 2 })).toBe('behaviors.validation.tooMany:{"max":2}');
        expect(issueMessage(t, { keyword: 'minItems', limit: 1 })).toBe('behaviors.validation.tooFew:{"min":1}');
    });

    it('falls back to a format message', () => {
        expect(issueMessage(t, { keyword: 'pattern' })).toBe('behaviors.validation.format');
        expect(issueMessage(t, { keyword: 'enum' })).toBe('behaviors.validation.invalid');
    });
});
